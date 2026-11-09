import type { MessagePortMain } from 'electron'
import type { ModelManager } from './model-manager'
import type { SpawnSttWorkerProcess } from './stt-worker-process'
import { prewarmSttModel } from './stt-session-prewarm'
import { startSttDictation } from './stt-session-start'
import { createSttSessionState, sttEngineUsers, type SttSessionState } from './stt-session-state'
import {
  prepareSttModelForDeletion,
  scheduleSttIdleTeardown,
  stopSttDictation,
  teardownIdleSttEngine
} from './stt-session-stop'

export { START_DICTATION_TIMEOUT_MS } from './stt-session-timeouts'

export type SttEvent =
  | { type: 'ready' }
  | { type: 'partial'; text?: string }
  | { type: 'final'; text?: string }
  | { type: 'stopped' }
  | { type: 'error'; error?: string }

export type SttEventSink = (event: SttEvent) => void

export class SttService {
  private readonly state: SttSessionState

  constructor(modelManager: ModelManager, spawnWorker: SpawnSttWorkerProcess) {
    this.state = createSttSessionState(modelManager, spawnWorker)
  }

  startDictation(
    modelId: string,
    sink: SttEventSink,
    hotwordsFilePath?: string,
    owner = 'desktop',
    language?: string
  ): Promise<void> {
    return startSttDictation(this.state, modelId, sink, hotwordsFilePath, owner, language)
  }

  feedAudio(samples: Float32Array, sampleRate: number, owner = 'desktop'): boolean {
    const session = this.state.sessions.get(owner)
    if (!session || session.phase === 'stopping') {
      return false
    }
    if (session.cloud) {
      return session.cloud.feedAudio(samples, sampleRate)
    }
    // postMessage copies the whole backing buffer, not just this view.
    const whole = samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength
    session.engine?.worker.postMessage({
      type: 'feed',
      streamId: session.streamId,
      samples: whole ? samples : samples.slice(),
      sampleRate
    })
    return false
  }

  /** Hands an active on-device session the renderer's port, so its audio skips this process. */
  attachAudioPort(owner: string, port: MessagePortMain): boolean {
    const session = this.state.sessions.get(owner)
    if (session?.phase !== 'active' || !session.engine) {
      return false
    }
    return session.engine.worker.attachAudioPort(session.streamId, port)
  }

  stopDictation(owner = 'desktop', options: { discard?: boolean } = {}): Promise<void> {
    return stopSttDictation(this.state, owner, options)
  }

  prepareModelForDeletion(modelId: string): Promise<void> {
    return prepareSttModelForDeletion(this.state, modelId)
  }

  /** The one warm-up entry point; an engine that needs a first inference to be fast does it behind this. */
  prewarm(modelId: string, language?: string, retryFailed = false): Promise<void> {
    return prewarmSttModel(this.state, modelId, language, retryFailed).catch((error: unknown) =>
      console.warn('[speech] Model pre-warm failed:', modelId, error)
    )
  }

  setIdleUnloadDelay(ms: number | null): void {
    if (this.state.idleUnloadMs === ms) {
      return
    }
    this.state.idleUnloadMs = ms
    const engine = this.state.engine
    if (engine && sttEngineUsers(this.state, engine).length === 0) {
      scheduleSttIdleTeardown(this.state)
    }
  }

  unloadIdleModel(): Promise<void> {
    // A pre-warm still reading the model state must not load it after this.
    this.state.prewarmGeneration += 1
    return teardownIdleSttEngine(this.state)
  }
}
