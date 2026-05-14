import { Worker } from 'worker_threads'
import { join } from 'path'
import { app } from 'electron'
import { getCatalogModel } from './model-catalog'
import type { ModelManager } from './model-manager'

export type SttEvent =
  | { type: 'ready' }
  | { type: 'partial'; text?: string }
  | { type: 'final'; text?: string }
  | { type: 'stopped' }
  | { type: 'error'; error?: string }

export type SttEventSink = (event: SttEvent) => void

export class SttService {
  private worker: Worker | null = null
  private modelManager: ModelManager
  private activeModelId: string | null = null
  private starting = false

  constructor(modelManager: ModelManager) {
    this.modelManager = modelManager
  }

  async startDictation(
    modelId: string,
    sink: SttEventSink,
    hotwordsFilePath?: string
  ): Promise<void> {
    if (this.starting) {
      return
    }
    this.starting = true

    try {
      await this._startDictation(modelId, sink, hotwordsFilePath)
    } finally {
      this.starting = false
    }
  }

  private async _startDictation(
    modelId: string,
    sink: SttEventSink,
    hotwordsFilePath?: string
  ): Promise<void> {
    if (this.worker) {
      await this.stopDictation()
    }

    const manifest = getCatalogModel(modelId)
    if (!manifest) {
      throw new Error(`Unknown model: ${modelId}`)
    }

    const modelState = await this.modelManager.getModelState(modelId)
    if (modelState.status !== 'ready') {
      throw new Error(`Model not ready: ${modelState.status}`)
    }

    const workerPath = this.getWorkerPath()
    const sherpaModulePath = this.getSherpaModulePath()

    this.worker = new Worker(workerPath, {
      workerData: { sherpaModulePath }
    })

    this.activeModelId = modelId

    const readyPromise = new Promise<void>((resolve, reject) => {
      const onReadyOrError = (msg: { type: string; text?: string; error?: string }) => {
        if (msg.type === 'ready') {
          this.worker?.off('message', onReadyOrError)
          resolve()
        } else if (msg.type === 'error') {
          this.worker?.off('message', onReadyOrError)
          reject(new Error(msg.error ?? 'Speech worker failed to initialize'))
        }
      }
      this.worker?.on('message', onReadyOrError)
    })

    this.worker.on('message', (msg: SttEvent) => {
      sink(msg)
    })

    this.worker.on('error', (err) => {
      sink({ type: 'error', error: String(err) })
      this.worker = null
      this.activeModelId = null
    })

    this.worker.on('exit', () => {
      this.worker = null
      this.activeModelId = null
    })

    const modelDir = this.modelManager.getModelDir(modelId)
    this.worker.postMessage({
      type: 'init',
      modelDir,
      modelType: manifest.type,
      streaming: manifest.streaming,
      sampleRate: manifest.sampleRate,
      files: manifest.files,
      hotwordsFilePath,
      modelingUnit: manifest.modelingUnit
    })

    await readyPromise
  }

  feedAudio(samples: Float32Array, sampleRate: number): void {
    this.worker?.postMessage({ type: 'feed', samples, sampleRate }, [samples.buffer as ArrayBuffer])
  }

  async stopDictation(): Promise<void> {
    if (!this.worker) {
      return
    }

    this.worker.postMessage({ type: 'stop' })

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.worker?.terminate()
        resolve()
      }, 3000)

      const onStopped = (msg: { type: string; text?: string; error?: string }) => {
        if (msg.type === 'stopped') {
          clearTimeout(timeout)
          this.worker?.off('message', onStopped)
          this.worker?.postMessage({ type: 'teardown' })
          resolve()
        }
      }
      this.worker?.on('message', onStopped)
    })

    this.worker.removeAllListeners()
    this.worker = null
    this.activeModelId = null
  }

  isActive(): boolean {
    return this.worker !== null
  }

  getActiveModelId(): string | null {
    return this.activeModelId
  }

  private getWorkerPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar', 'out', 'main', 'stt-worker.js')
    }
    return join(__dirname, 'stt-worker.js')
  }

  private getSherpaModulePath(): string {
    // Why: the main sherpa-onnx npm package uses WASM, which cannot access
    // the host filesystem to load model files. The platform-specific native
    // addon (e.g. sherpa-onnx-darwin-arm64) has direct filesystem access
    // and better performance. We resolve its absolute path here because
    // the worker runs from out/main/ where bare require() can't find it.
    const nativePkg = `sherpa-onnx-${process.platform}-${process.arch}`

    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', nativePkg)
    }

    const resolved = require.resolve(nativePkg)
    return join(resolved, '..')
  }
}
