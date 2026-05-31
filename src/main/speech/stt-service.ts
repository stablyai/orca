/* eslint-disable max-lines -- Why: speech worker ownership, warm reuse, and
timeout teardown must stay co-located so dictation lifecycle state cannot drift. */
import { Worker } from 'worker_threads'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getCatalogModel } from './model-catalog'
import type { ModelManager } from './model-manager'

export const START_DICTATION_TIMEOUT_MS = 60_000
const STOP_DICTATION_TIMEOUT_MS = 60_000
export const IDLE_WORKER_TEARDOWN_MS = 60 * 60 * 1000

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
  private activeHotwordsFilePath: string | undefined
  private activeOwner: string | null = null
  private startingOwner: string | null = null
  private starting = false
  private canceledOwners = new Set<string>()
  private eventSink: SttEventSink | null = null
  private idleTeardownTimer: NodeJS.Timeout | null = null
  // Why: warm workers intentionally keep lifecycle listeners while reusable;
  // stale workers must not retain this service after error, exit, or teardown.
  private cleanupWorkerLifecycleListeners: (() => void) | null = null

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
    if (this.worker && this.activeOwner && this.activeOwner !== owner) {
      throw new Error('dictation_already_active')
    }
    this.starting = true
    this.startingOwner = owner
    this.clearIdleTeardownTimer()

    try {
      await this._startDictation(modelId, sink, hotwordsFilePath, owner)
      if (this.canceledOwners.delete(owner)) {
        await this.stopDictation(owner, { cancelStarting: false })
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
    if (
      this.worker &&
      this.activeModelId === modelId &&
      this.activeHotwordsFilePath === hotwordsFilePath
    ) {
      this.eventSink = sink
      sink({ type: 'ready' })
      return
    }

    if (this.worker) {
      await this.stopDictation(owner, { cancelStarting: false })
      await this.teardownIdleWorker()
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
    this.activeHotwordsFilePath = hotwordsFilePath
    this.eventSink = sink

    const readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      let startupTimeout: ReturnType<typeof setTimeout> | null = null
      const cleanup = () => {
        if (startupTimeout) {
          clearTimeout(startupTimeout)
          startupTimeout = null
        }
        worker.off('message', onReadyOrError)
        worker.off('error', onStartupError)
        worker.off('exit', onStartupExit)
      }
      const failStartup = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
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
          failStartup(new Error(msg.error ?? 'Speech worker failed to initialize'))
        }
      }
      const onStartupError = (err: Error) => {
        failStartup(err)
      }
      const onStartupExit = (code: number) => {
        failStartup(new Error(`Speech worker exited before ready: ${code}`))
      }
      worker.on('message', onReadyOrError)
      worker.on('error', onStartupError)
      worker.on('exit', onStartupExit)
      // Why: a native STT worker can wedge while loading model bindings without
      // emitting ready/error/exit; startup must leave the UI's Starting state.
      startupTimeout = setTimeout(() => {
        failStartup(new Error('Speech worker timed out while starting.'))
      }, START_DICTATION_TIMEOUT_MS)
      startupTimeout.unref?.()
    })

    const onWorkerMessage = (msg: SttEvent) => {
      this.eventSink?.(msg)
    }

    const onWorkerError = (err: Error) => {
      this.eventSink?.({ type: 'error', error: String(err) })
      if (this.worker === worker) {
        this.cleanupActiveWorkerLifecycleListeners()
        this.worker = null
        this.activeModelId = null
        this.activeHotwordsFilePath = undefined
        this.activeOwner = null
        this.eventSink = null
      }
    }

    const onWorkerExit = () => {
      if (this.worker === worker) {
        this.cleanupActiveWorkerLifecycleListeners()
        this.worker = null
        this.activeModelId = null
        this.activeHotwordsFilePath = undefined
        this.activeOwner = null
        this.eventSink = null
      }
    }

    worker.on('message', onWorkerMessage)
    worker.on('error', onWorkerError)
    worker.on('exit', onWorkerExit)
    this.cleanupWorkerLifecycleListeners = () => {
      worker.off('message', onWorkerMessage)
      worker.off('error', onWorkerError)
      worker.off('exit', onWorkerExit)
    }

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
      this.cleanupActiveWorkerLifecycleListeners()
      worker.removeAllListeners()
      void worker.terminate()
      if (this.worker === worker) {
        this.worker = null
        this.activeModelId = null
        this.activeHotwordsFilePath = undefined
        this.activeOwner = null
        this.eventSink = null
      }
      throw error
    }
  }

  feedAudio(samples: Float32Array, sampleRate: number, owner = 'desktop'): void {
    const currentOwner = this.activeOwner ?? this.startingOwner
    if (!currentOwner) {
      return
    }
    if (currentOwner !== owner) {
      throw new Error('dictation_owner_mismatch')
    }
    this.worker?.postMessage({ type: 'feed', samples, sampleRate }, [samples.buffer as ArrayBuffer])
  }

  async stopDictation(
    owner = 'desktop',
    options: { cancelStarting?: boolean } = { cancelStarting: true }
  ): Promise<void> {
    if (options.cancelStarting !== false && this.startingOwner === owner) {
      this.canceledOwners.add(owner)
    }
    if (!this.worker) {
      return
    }
    const currentOwner = this.activeOwner ?? this.startingOwner
    if (currentOwner && currentOwner !== owner) {
      throw new Error('dictation_owner_mismatch')
    }

    const worker = this.worker
    worker.postMessage({ type: 'stop' })

    let forcedTeardown = false
    await new Promise<void>((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        worker.off('message', onStopped)
      }

      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve()
      }

      const onStopped = (msg: { type: string; text?: string; error?: string }) => {
        if (msg.type === 'stopped') {
          finish()
        }
      }

      timeout = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        forcedTeardown = true
        cleanup()
        // Why: a worker that cannot finish dictation is no longer reusable; do
        // not keep it in the warm-worker slot or retain its message listeners.
        this.cleanupActiveWorkerLifecycleListeners()
        worker.removeAllListeners()
        void worker.terminate().finally(resolve)
      }, STOP_DICTATION_TIMEOUT_MS)

      worker.on('message', onStopped)
    })

    if (this.worker === worker) {
      if (forcedTeardown) {
        this.worker = null
        this.activeModelId = null
        this.activeHotwordsFilePath = undefined
        this.activeOwner = null
        this.eventSink = null
      } else {
        this.activeOwner = null
        this.eventSink = null
        this.scheduleIdleTeardown()
      }
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

  private clearIdleTeardownTimer(): void {
    if (this.idleTeardownTimer) {
      clearTimeout(this.idleTeardownTimer)
      this.idleTeardownTimer = null
    }
  }

  private scheduleIdleTeardown(): void {
    this.clearIdleTeardownTimer()
    // Why: keep the native recognizer warm for repeated dictations, but release
    // the ONNX model after a quiet period so long-running Orca sessions don't
    // pin speech memory forever.
    this.idleTeardownTimer = setTimeout(() => {
      void this.teardownIdleWorker()
    }, IDLE_WORKER_TEARDOWN_MS)
    this.idleTeardownTimer.unref?.()
  }

  private async teardownIdleWorker(): Promise<void> {
    this.clearIdleTeardownTimer()
    if (!this.worker || this.activeOwner || this.startingOwner) {
      return
    }
    const worker = this.worker
    worker.postMessage({ type: 'teardown' })
    this.cleanupActiveWorkerLifecycleListeners()
    worker.removeAllListeners()
    await worker.terminate().catch(() => undefined)
    if (this.worker === worker) {
      this.worker = null
      this.activeModelId = null
      this.activeHotwordsFilePath = undefined
      this.eventSink = null
    }
  }

  private cleanupActiveWorkerLifecycleListeners(): void {
    const cleanup = this.cleanupWorkerLifecycleListeners
    this.cleanupWorkerLifecycleListeners = null
    cleanup?.()
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
      const resourcesNodeModule = join(process.resourcesPath, 'node_modules', nativePkg)
      if (existsSync(resourcesNodeModule)) {
        return resourcesNodeModule
      }
      return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', nativePkg)
    }

    const resolved = require.resolve(nativePkg)
    return join(resolved, '..')
  }
}
