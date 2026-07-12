/* eslint-disable max-lines -- Why: speech worker ownership, warm reuse, and
timeout teardown must stay co-located so dictation lifecycle state cannot drift. */
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getCatalogModel } from './model-catalog'
import type { ModelManager } from './model-manager'
import { OpenAiTranscriptionSession } from './openai-transcription-client'
import { readOpenAiSpeechApiKey } from './openai-api-key-store'

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

type StopInFlight = {
  worker: Worker
  owner: string
  promise: Promise<void>
}

type StopOutcome = 'stopped' | 'error' | 'exit' | 'timeout'

export class SttService {
  private worker: Worker | null = null
  private cloudSession: OpenAiTranscriptionSession | null = null
  private modelManager: ModelManager
  private activeModelId: string | null = null
  private activeHotwordsFilePath: string | undefined
  private activeOwner: string | null = null
  private startingOwner: string | null = null
  private startingModelId: string | null = null
  private starting = false
  private canceledOwners = new Set<string>()
  private eventSink: SttEventSink | null = null
  private idleTeardownTimer: NodeJS.Timeout | null = null
  private stopInFlight: StopInFlight | null = null
  // Why: stop resolves only after the worker flushes; in-flight feedAudio IPC
  // must not enqueue samples after that flush or they stick on the warm worker
  // and contaminate the next dictation session.
  private stopping = false
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
    if ((this.worker || this.cloudSession) && this.activeOwner && this.activeOwner !== owner) {
      throw new Error('dictation_already_active')
    }
    this.starting = true
    this.startingOwner = owner
    this.startingModelId = modelId
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
      this.startingModelId = null
      this.canceledOwners.delete(owner)
    }
  }

  private async _startDictation(
    modelId: string,
    sink: SttEventSink,
    hotwordsFilePath?: string,
    owner = 'desktop'
  ): Promise<void> {
    const manifest = getCatalogModel(modelId)
    if (!manifest) {
      throw new Error(`Unknown model: ${modelId}`)
    }

    if (manifest.provider === 'openai') {
      if (this.worker) {
        const existingWorker = this.worker
        await this.stopDictation(owner, { cancelStarting: false })
        await this.teardownWorker(existingWorker)
      }

      const modelState = await this.modelManager.getModelState(modelId)
      if (modelState.status !== 'ready') {
        throw new Error(`Model not ready: ${modelState.status}`)
      }

      this.cloudSession = new OpenAiTranscriptionSession(modelId, readOpenAiSpeechApiKey)
      this.activeModelId = modelId
      this.activeHotwordsFilePath = undefined
      this.eventSink = sink
      sink({ type: 'ready' })
      return
    }

    if (this.cloudSession) {
      await this.stopDictation(owner, { cancelStarting: false })
    }

    const reusableWorker = this.worker
    if (
      reusableWorker &&
      this.activeModelId === modelId &&
      this.activeHotwordsFilePath === hotwordsFilePath &&
      this.stopInFlight?.worker !== reusableWorker
    ) {
      const worker = reusableWorker
      if (!this.activeOwner) {
        const modelState = await this.modelManager.getModelState(modelId)
        if (modelState.status !== 'ready') {
          await this.teardownWorker(worker)
          throw new Error(`Model not ready: ${modelState.status}`)
        }
      }
      if (
        this.worker === worker &&
        this.activeModelId === modelId &&
        this.activeHotwordsFilePath === hotwordsFilePath &&
        this.stopInFlight?.worker !== worker
      ) {
        this.eventSink = sink
        sink({ type: 'ready' })
        return
      }
    }

    if (this.worker) {
      const existingWorker = this.worker
      await this.stopDictation(owner, { cancelStarting: false })
      await this.teardownWorker(existingWorker)
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
      if (this.worker === worker) {
        this.eventSink?.(msg)
      }
    }

    const onWorkerError = (err: Error) => {
      if (this.worker === worker) {
        this.eventSink?.({ type: 'error', error: String(err) })
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
      files: manifest.files ?? [],
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
    if (this.stopping) {
      return
    }
    const currentOwner = this.activeOwner ?? this.startingOwner
    if (!currentOwner) {
      return
    }
    if (currentOwner !== owner) {
      throw new Error('dictation_owner_mismatch')
    }
    if (this.cloudSession) {
      this.cloudSession.feedAudio(samples, sampleRate)
      return
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
    if (!this.worker && !this.cloudSession) {
      return
    }
    const currentOwner = this.activeOwner ?? this.startingOwner
    if (currentOwner && currentOwner !== owner) {
      throw new Error('dictation_owner_mismatch')
    }

    if (this.cloudSession) {
      this.stopping = true
      try {
        const session = this.cloudSession
        this.cloudSession = null
        try {
          const text = await session.finish()
          if (text) {
            this.eventSink?.({ type: 'final', text })
          }
        } catch (error) {
          this.eventSink?.({
            type: 'error',
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          this.eventSink?.({ type: 'stopped' })
          this.activeModelId = null
          this.activeHotwordsFilePath = undefined
          this.activeOwner = null
          this.eventSink = null
        }
      } finally {
        this.stopping = false
      }
      return
    }

    const worker = this.worker
    if (!worker) {
      return
    }
    if (this.stopInFlight?.worker === worker) {
      if (this.stopInFlight.owner !== owner) {
        throw new Error('dictation_owner_mismatch')
      }
      return this.stopInFlight.promise
    }

    const capturedSink = this.eventSink
    let stopPromise!: Promise<void>
    stopPromise = this.createStopPromise(worker, capturedSink).finally(() => {
      if (this.stopInFlight?.worker === worker && this.stopInFlight.promise === stopPromise) {
        this.stopInFlight = null
      }
    })
    this.stopInFlight = { worker, owner, promise: stopPromise }
    this.stopping = true
    try {
      // Why: keep the stop message inside the try so a postMessage throw still
      // clears `stopping` — otherwise feedAudio silently drops all future audio.
      worker.postMessage({ type: 'stop' })
      await stopPromise
    } finally {
      this.stopping = false
    }
  }

  private createStopPromise(worker: Worker, capturedSink: SttEventSink | null): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      let receivedStopped = false
      let timeout: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        worker.off('message', onStopped)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }

      const finish = (outcome: StopOutcome): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (outcome === 'stopped') {
          if (this.worker === worker) {
            this.activeOwner = null
            this.eventSink = null
            this.scheduleIdleTeardown()
          }
          resolve()
          return
        }

        if (!receivedStopped) {
          capturedSink?.({ type: 'stopped' })
        }
        // Why: a worker that cannot finish dictation is no longer reusable; drop
        // its lifecycle listeners so a stale worker can't retain this service.
        this.cleanupActiveWorkerLifecycleListeners()
        worker.removeAllListeners()
        if (outcome !== 'exit') {
          void worker.terminate().catch(() => undefined)
        }
        if (this.worker === worker) {
          this.worker = null
          this.activeModelId = null
          this.activeHotwordsFilePath = undefined
          this.activeOwner = null
          this.eventSink = null
        }
        resolve()
      }

      const onStopped = (msg: { type: string; text?: string; error?: string }) => {
        if (msg.type === 'stopped') {
          receivedStopped = true
          finish('stopped')
        }
      }

      const onError = (): void => {
        finish('error')
      }

      const onExit = (): void => {
        finish('exit')
      }

      timeout = setTimeout(() => {
        finish('timeout')
      }, STOP_DICTATION_TIMEOUT_MS)
      timeout.unref?.()

      worker.on('message', onStopped)
      worker.on('error', onError)
      worker.on('exit', onExit)
    })
  }

  isActive(): boolean {
    return this.worker !== null || this.cloudSession !== null
  }

  getActiveModelId(): string | null {
    return this.activeModelId
  }

  async prepareModelForDeletion(modelId: string): Promise<void> {
    if (this.startingModelId === modelId || (this.activeOwner && this.activeModelId === modelId)) {
      throw new Error('voice_model_in_use')
    }
    if (this.worker && this.activeModelId === modelId) {
      await this.teardownIdleWorker({ ignoreTerminateErrors: false })
      if (this.worker && this.activeModelId === modelId) {
        throw new Error('voice_model_in_use')
      }
    }
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

  private async teardownIdleWorker(
    options: { ignoreTerminateErrors?: boolean } = { ignoreTerminateErrors: true }
  ): Promise<void> {
    this.clearIdleTeardownTimer()
    if (!this.worker || this.activeOwner || this.startingOwner) {
      return
    }
    await this.teardownWorker(this.worker, options)
  }

  private async teardownWorker(
    worker: Worker,
    options: { ignoreTerminateErrors?: boolean } = { ignoreTerminateErrors: true }
  ): Promise<void> {
    this.clearIdleTeardownTimer()
    if (this.stopInFlight?.worker === worker) {
      await this.stopInFlight.promise
    }
    try {
      worker.postMessage({ type: 'teardown' })
    } catch {
      // The worker may already have exited on a forced stop path.
    }
    this.cleanupActiveWorkerLifecycleListeners()
    worker.removeAllListeners()
    try {
      await worker.terminate()
    } catch (error) {
      if (!options.ignoreTerminateErrors) {
        throw error
      }
    }
    if (this.worker === worker) {
      this.worker = null
      this.activeModelId = null
      this.activeHotwordsFilePath = undefined
      this.activeOwner = null
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
