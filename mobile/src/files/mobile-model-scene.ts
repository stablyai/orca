// Ported from the desktop's src/renderer/src/components/editor/glb-scene.ts and
// gltf-model-parse.ts (not imported, like the rest of the mobile bundle), trimmed to what the
// page's CSP allows: no workers and no WebAssembly, so Draco and meshopt models are refused.
import {
  ACESFilmicToneMapping,
  type AnimationClip,
  Box3,
  DirectionalLight,
  HemisphereLight,
  type Material,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { createMobileModelAnimation } from './mobile-model-animation'
import { createMobileModelGuides, type MobileModelDimensions } from './mobile-model-guides'

const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a
const DECODER_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression']

export class MobileModelUnsupportedError extends Error {}

export type MobileModelStats = { vertices: number; triangles: number }

export type MobileModelSceneHandle = {
  stats: MobileModelStats
  dimensions: MobileModelDimensions
  gridCellSize: number
  animationNames: string[]
  resetView: () => void
  setGuidesVisible: (visible: boolean) => void
  playAnimation: (clipIndex: number) => void
  setAnimationPaused: (paused: boolean) => void
  dispose: () => void
}

type ParsedModel = { scene: Object3D; animations: AnimationClip[] }

function decodeBase64(content: string): ArrayBuffer {
  const binary = atob(content.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

function glbExtensions(data: ArrayBuffer): string[] {
  const view = new DataView(data)
  if (data.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) {
    return []
  }
  const length = view.getUint32(12, true)
  if (view.getUint32(16, true) !== GLB_JSON_CHUNK_TYPE || 20 + length > data.byteLength) {
    return []
  }
  try {
    const document: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, length)))
    if (typeof document !== 'object' || document === null || !('extensionsUsed' in document)) {
      return []
    }
    const used = document.extensionsUsed
    return Array.isArray(used) ? used.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function parseGlb(data: ArrayBuffer): Promise<ParsedModel> {
  if (glbExtensions(data).some((extension) => DECODER_EXTENSIONS.includes(extension))) {
    return Promise.reject(new MobileModelUnsupportedError('compressed_model'))
  }
  const loader = new GLTFLoader()
  // Why: ImageBitmapLoader fetch()es the blob: URL of an embedded texture, which the page's
  // `connect-src 'self'` refuses; an <img> load falls under `img-src blob:`, which allows it.
  loader.register((parser) => {
    parser.textureLoader = new TextureLoader(parser.options.manager)
    return { name: 'orca_image_element_textures' }
  })
  return new Promise((resolve, reject) => {
    loader.parse(
      data,
      '',
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
      reject
    )
  })
}

function collectMeshes(root: Object3D): Mesh[] {
  const meshes: Mesh[] = []
  root.traverse((node) => {
    if (node instanceof Mesh) {
      meshes.push(node)
    }
  })
  return meshes
}

function meshMaterials(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

function measureMeshes(meshes: Mesh[]): MobileModelStats {
  let vertices = 0
  let triangles = 0
  for (const mesh of meshes) {
    const count = mesh.geometry.getAttribute('position')?.count ?? 0
    vertices += count
    triangles += Math.floor((mesh.geometry.index?.count ?? count) / 3)
  }
  return { vertices, triangles }
}

function disposeMeshes(meshes: Mesh[]): void {
  for (const mesh of meshes) {
    mesh.geometry.dispose()
    for (const material of meshMaterials(mesh)) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) {
          value.dispose()
        }
      }
      material.dispose()
    }
  }
}

/** Parses a base64 GLB and mounts it into `host`, rendering only on camera or size changes. */
export async function createMobileModelScene(
  host: HTMLElement,
  base64: string,
  onContextLost: () => void,
  isCancelled: () => boolean
): Promise<MobileModelSceneHandle | null> {
  const { scene: model, animations } = await parseGlb(decodeBase64(base64))
  const meshes = collectMeshes(model)
  if (isCancelled()) {
    disposeMeshes(meshes)
    return null
  }
  for (const mesh of meshes) {
    if (!mesh.geometry.getAttribute('normal')) {
      mesh.geometry.computeVertexNormals()
    }
  }

  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.touchAction = 'none'
  host.appendChild(renderer.domElement)

  const scene = new Scene()
  const pmrem = new PMREMGenerator(renderer)
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = environment
  scene.add(new HemisphereLight(0xffffff, 0x444444, 0.6))
  const keyLight = new DirectionalLight(0xffffff, 1.2)
  keyLight.position.set(1, 2, 1.5)
  scene.add(keyLight)
  scene.add(model)

  const camera = new PerspectiveCamera(45, 1, 0.01, 1000)
  const controls = new OrbitControls(camera, renderer.domElement)
  const render = (): void => renderer.render(scene, camera)
  controls.addEventListener('change', render)

  const bounds = new Box3().setFromObject(model)
  const guides = createMobileModelGuides(bounds)
  scene.add(guides.group)
  const animation = createMobileModelAnimation(model, animations, renderer, render)
  const center = bounds.getCenter(new Vector3())
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 1e-3)
  const resetView = (): void => {
    const distance = radius / Math.sin((camera.fov * Math.PI) / 360)
    camera.near = distance / 100
    camera.far = distance * 100
    camera.position.copy(center).add(new Vector3(0.6, 0.4, 1).normalize().multiplyScalar(distance))
    camera.updateProjectionMatrix()
    controls.target.copy(center)
    controls.update()
    render()
  }

  const resize = (): void => {
    const width = Math.max(host.clientWidth, 1)
    const height = Math.max(host.clientHeight, 1)
    renderer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    render()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)

  const handleContextLost = (event: Event): void => {
    event.preventDefault()
    onContextLost()
  }
  renderer.domElement.addEventListener('webglcontextlost', handleContextLost)

  resize()
  resetView()

  return {
    stats: measureMeshes(meshes),
    dimensions: guides.dimensions,
    gridCellSize: guides.gridCellSize,
    animationNames: animation.clipNames,
    resetView,
    setGuidesVisible: (visible) => {
      guides.group.visible = visible
      render()
    },
    playAnimation: animation.play,
    setAnimationPaused: (paused) => {
      animation.setPaused(paused)
      render()
    },
    dispose: () => {
      animation.dispose()
      observer.disconnect()
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost)
      controls.dispose()
      disposeMeshes(meshes)
      guides.dispose()
      environment.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }
}
