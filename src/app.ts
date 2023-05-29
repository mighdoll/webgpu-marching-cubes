import {ArcballCamera} from "arcball_camera";
import {Controller} from "ez_canvas_controller";
import {mat4, vec3} from "gl-matrix";

import {Volume, volumes} from "./volume";
import {MarchingCubes} from "./marching_cubes";
import renderMeshShaders from "./render_mesh.wgsl";
import {compileShader, fillSelector} from "./util";

(async () =>
{
    if (navigator.gpu === undefined) {
        document.getElementById("webgpu-canvas").setAttribute("style", "display:none;");
        document.getElementById("no-webgpu").setAttribute("style", "display:block;");
        return;
    }

    // Get a GPU device to render with
    let adapter = await navigator.gpu.requestAdapter();
    console.log(adapter.limits);
    let requestedLimits = {
        requiredLimits: {maxBufferSize: adapter.limits.maxBufferSize},
    };

    let device = await adapter.requestDevice(requestedLimits);

    // Get a context to display our rendered image on the canvas
    let canvas = document.getElementById("webgpu-canvas") as HTMLCanvasElement;
    let context = canvas.getContext("webgpu");

    let volumePicker = document.getElementById("volumeList") as HTMLSelectElement;
    fillSelector(volumePicker, volumes);

    // Setup shader modules
    let shaderModule = await compileShader(device, renderMeshShaders, "renderMeshShaders");

    let volume = await Volume.load(volumes.get("Fuel"), device);
    let marching_cubes = await MarchingCubes.create(volume, device);
    let isosurface = await marching_cubes.computeSurface(0.5);

    // Vertex attribute state and shader stage
    let vertexState = {
        // Shader stage info
        module: shaderModule,
        entryPoint: "vertex_main",
        // Vertex buffer info
        buffers: [{
            arrayStride: 4 * 4,
            attributes: [
                {format: "float32x4" as GPUVertexFormat, offset: 0, shaderLocation: 0}
            ]
        }]
    };

    // Setup render outputs
    let swapChainFormat = "bgra8unorm" as GPUTextureFormat;
    context.configure(
        {device: device, format: swapChainFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT});

    let depthFormat = "depth24plus-stencil8" as GPUTextureFormat;
    let depthTexture = device.createTexture({
        size: {width: canvas.width, height: canvas.height, depthOrArrayLayers: 1},
        format: depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    let fragmentState = {
        // Shader info
        module: shaderModule,
        entryPoint: "fragment_main",
        // Output render target info
        targets: [{format: swapChainFormat}]
    };

    let bindGroupLayout = device.createBindGroupLayout({
        entries: [{binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {type: "uniform"}}]
    });

    // Create render pipeline
    let layout = device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]});

    let renderPipeline = device.createRenderPipeline({
        layout: layout,
        vertex: vertexState,
        fragment: fragmentState,
        depthStencil: {format: depthFormat, depthWriteEnabled: true, depthCompare: "less"}
    });

    let renderPassDesc = {
        colorAttachments: [{
            view: null as GPUTextureView,
            loadOp: "clear" as GPULoadOp,
            clearValue: [0.3, 0.3, 0.3, 1],
            storeOp: "store" as GPUStoreOp
        }],
        depthStencilAttachment: {
            view: depthTexture.createView(),
            depthLoadOp: "clear" as GPULoadOp,
            depthClearValue: 1.0,
            depthStoreOp: "store" as GPUStoreOp,
            stencilLoadOp: "clear" as GPULoadOp,
            stencilClearValue: 0,
            stencilStoreOp: "store" as GPUStoreOp
        }
    };

    let viewParamsBuffer = device.createBuffer({
        size: (4 * 4 + 4) * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: false,
    });

    let uploadBuffer = device.createBuffer({
        size: viewParamsBuffer.size,
        usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: false,
    });

    let bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [{binding: 0, resource: {buffer: viewParamsBuffer}}]
    });

    // Setup camera and camera controls
    const defaultEye = vec3.set(vec3.create(), 0.0, 0.0, volume.dims[2] * 0.75);
    const center = vec3.set(vec3.create(), 0.0, 0.0, 0.5);
    const up = vec3.set(vec3.create(), 0.0, 1.0, 0.0);
    let camera = new ArcballCamera(defaultEye, center, up, 2, [canvas.width, canvas.height]);
    let proj = mat4.perspective(
        mat4.create(), 50 * Math.PI / 180.0, canvas.width / canvas.height, 0.1, 1000);
    let projView = mat4.create();

    // Register mouse and touch listeners
    var controller = new Controller();
    controller.mousemove = function (prev: Array<number>, cur: Array<number>, evt: MouseEvent)
    {
        if (evt.buttons == 1) {
            camera.rotate(prev, cur);

        } else if (evt.buttons == 2) {
            camera.pan([cur[0] - prev[0], prev[1] - cur[1]]);
        }
    };
    controller.wheel = function (amt: number)
    {
        camera.zoom(amt);
    };
    controller.pinch = controller.wheel;
    controller.twoFingerDrag = function (drag: number)
    {
        camera.pan(drag);
    };
    controller.registerForCanvas(canvas);

    let animationFrame = function ()
    {
        let resolve = null;
        let promise = new Promise(r => resolve = r);
        window.requestAnimationFrame(resolve);
        return promise
    };
    requestAnimationFrame(animationFrame);

    // Render!
    while (true) {
        await animationFrame();
        if (document.hidden) {
            continue;
        }

        projView = mat4.mul(projView, proj, camera.camera);
        {
            await uploadBuffer.mapAsync(GPUMapMode.WRITE);
            let map = uploadBuffer.getMappedRange();
            new Float32Array(map).set(projView);
            new Uint32Array(map, 16 * 4, 4).set(volume.dims);
            uploadBuffer.unmap();
        }

        renderPassDesc.colorAttachments[0].view = context.getCurrentTexture().createView();

        let commandEncoder = device.createCommandEncoder();

        commandEncoder.copyBufferToBuffer(
            uploadBuffer, 0, viewParamsBuffer, 0, viewParamsBuffer.size);

        let renderPass = commandEncoder.beginRenderPass(renderPassDesc);

        renderPass.setBindGroup(0, bindGroup);
        renderPass.setPipeline(renderPipeline);
        renderPass.setVertexBuffer(0, isosurface.buffer);
        renderPass.draw(isosurface.count, 1, 0, 0);

        renderPass.end();
        device.queue.submit([commandEncoder.finish()]);
    }
})();
