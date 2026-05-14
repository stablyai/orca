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
  private activeOwner: string | null = null
  private startingOwner: string | null = null
  private starting = false
  private canceledOwners = new Set<string>()

  constructor(modelManager: ModelManager) {
    this.modelManager = modelManager
  }

  async startDictation(
    modelId: string,
    sink: SttEventSink,
    hotwordsFilePath?: string,
    owner = 'desktop'
  ): Promise<void> {
    if (this.starting) {
      if (this.startingOwner !== owner) {
        throw new Error('dictation_already_active')
      }
      return
    }
    if (this.worker && this.activeOwner !== owner) {
      throw new Error('dictation_already_active')
    }
    this.starting = true
    this.startingOwner = owner

    try {
      await this._startDictation(modelId, sink, hotwordsFilePath, owner)
      if (this.canceledOwners.delete(owner)) {
        await this.stopDictation(owner)
        throw new Error('dictation_canceled')
      }
      this.activeOwner = owner
    } finally {
      this.starting = false
      this.startingOwner = null
      this.canceledOwners.delete(owner)
    }
  }

  private async _startDictation(
    modelId: string,
    sink: SttEventSink,
    hotwordsFilePath?: string,
    owner = 'desktop'
  ): Promise<void> {
    if (this.worker) {
      await this.stopDictation(owner)
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
    const worker = this.worker

    this.activeModelId = modelId

    const readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        worker.off('message', onReadyOrError)
        worker.off('error', onStartupError)
        worker.off('exit', onStartupExit)
      }
      const onReadyOrError = (msg: { type: string; text?: string; error?: string }) => {
        if (settled) {
          return
        }
        if (msg.type === 'ready') {
          settled = true
          cleanup()
          resolve()
        } else if (msg.type === 'error') {
          settled = true
          cleanup()
          reject(new Error(msg.error ?? 'Speech worker failed to initialize'))
        }
      }
      const onStartupError = (err: Error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(err)
      }
      const onStartupExit = (code: number) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(new Error(`Speech worker exited before ready: ${code}`))
      }
      worker.on('message', onReadyOrError)
      worker.on('error', onStartupError)
      worker.on('exit', onStartupExit)
    })

    worker.on('message', (msg: SttEvent) => {
      sink(msg)
    })

    worker.on('error', (err) => {
      sink({ type: 'error', error: String(err) })
      if (this.worker === worker) {
        this.worker = null
        this.activeModelId = null
        this.activeOwner = null
      }
    })

    worker.on('exit', () => {
      if (this.worker === worker) {
        this.worker = null
        this.activeModelId = null
        this.activeOwner = null
      }
    })

    const modelDir = this.modelManager.getModelDir(modelId)
    worker.postMessage({
      type: 'init',
      modelDir,
      modelType: manifest.type,
      streaming: manifest.streaming,
      sampleRate: manifest.sampleRate,
      files: manifest.files,
      hotwordsFilePath,
      modelingUnit: manifest.modelingUnit
    })

    try {
      await readyPromise
    } catch (error) {
      worker.removeAllListeners()
      void worker.terminate()
      if (this.worker === worker) {
        this.worker = null
        this.activeModelId = null
        this.activeOwner = null
      }
      throw error
    }
  }

  feedAudio(samples: Float32Array, sampleRate: number, owner = 'desktop'): void {
    const currentOwner = this.activeOwner ?? this.startingOwner
    if (currentOwner && currentOwner !== owner) {
      throw new Error('dictation_owner_mismatch')
    }
    this.worker?.postMessage({ type: 'feed', samples, sampleRate }, [samples.buffer as ArrayBuffer])
  }

  async stopDictation(owner = 'desktop'): Promise<void> {
    if (!this.worker) {
      if (this.startingOwner === owner) {
        this.canceledOwners.add(owner)
      }
      return
    }
    const currentOwner = this.activeOwner ?? this.startingOwner
    if (currentOwner && currentOwner !== owner) {
      throw new Error('dictation_owner_mismatch')
    }

    const worker = this.worker
    worker.postMessage({ type: 'stop' })

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        worker.terminate()
        resolve()
      }, 3000)

      const onStopped = (msg: { type: string; text?: string; error?: string }) => {
        if (msg.type === 'stopped') {
          clearTimeout(timeout)
          worker.off('message', onStopped)
          worker.postMessage({ type: 'teardown' })
          resolve()
        }
      }
      worker.on('message', onStopped)
    })

    worker.removeAllListeners()
    if (this.worker === worker) {
      this.worker = null
      this.activeModelId = null
      this.activeOwner = null
    }
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
    const nativePkg =
      process.platform === 'win32' && process.arch === 'x64'
        ? 'sherpa-onnx-win-x64'
        : `sherpa-onnx-${process.platform}-${process.arch}`

    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', nativePkg)
    }

    const resolved = require.resolve(nativePkg)
    return join(resolved, '..')
  }
}
