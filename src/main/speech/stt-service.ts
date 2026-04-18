import { Worker } from 'worker_threads'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
import { getCatalogModel } from './model-catalog'
import type { ModelManager } from './model-manager'

export class SttService {
  private worker: Worker | null = null
  private modelManager: ModelManager
  private activeModelId: string | null = null

  constructor(modelManager: ModelManager) {
    this.modelManager = modelManager
  }

  async startDictation(modelId: string, window: BrowserWindow): Promise<void> {
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

    this.worker.on('message', (msg: { type: string; text?: string; error?: string }) => {
      if (window.isDestroyed()) {
        return
      }
      switch (msg.type) {
        case 'ready':
          window.webContents.send('speech:ready')
          break
        case 'partial':
          window.webContents.send('speech:partial', msg.text)
          break
        case 'final':
          window.webContents.send('speech:final', msg.text)
          break
        case 'stopped':
          window.webContents.send('speech:stopped')
          break
        case 'error':
          window.webContents.send('speech:error', msg.error)
          break
      }
    })

    this.worker.on('error', (err) => {
      if (!window.isDestroyed()) {
        window.webContents.send('speech:error', String(err))
      }
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
      files: manifest.files
    })
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

      this.worker?.once('message', (msg: { type: string; text?: string; error?: string }) => {
        if (msg.type === 'stopped') {
          clearTimeout(timeout)
          this.worker?.postMessage({ type: 'teardown' })
          resolve()
        }
      })
    })

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
