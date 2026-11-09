import type { MessagePortMain } from 'electron'
import { dictationVocabulary, type DictationTerm } from '../../shared/dictation-dictionary'
import {
  createDictationTextPipeline,
  type DictationTextSettings
} from '../../shared/dictation-text-pipeline'
import { getCatalogModel } from './model-catalog'
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

// Cleaned once here, so every route the host transcribes for gets the same text.
function cleanTranscriptEvents(sink: SttEventSink, clean: (text: string) => string): SttEventSink {
  return (event) =>
    sink(
      event.type === 'partial' || event.type === 'final'
        ? { ...event, text: event.text && clean(event.text) }
        : event
    )
}

export class SttService {
  private readonly state: SttSessionState

  constructor(modelManager: ModelManager, spawnWorker: SpawnSttWorkerProcess) {
    this.state = createSttSessionState(modelManager, spawnWorker)
  }

  /** `terms`: the dictionary for where this dictation goes, repo terms first (mergeDictationTerms). */
  startDictation(
    modelId: string,
    sink: SttEventSink,
    terms: readonly DictationTerm[] = [],
    owner = 'desktop',
    voice?: Partial<DictationTextSettings>
  ): Promise<void> {
    const clean = createDictationTextPipeline(getCatalogModel(modelId), voice, terms)
    return startSttDictation(
      this.state,
      modelId,
      clean ? cleanTranscriptEvents(sink, clean) : sink,
      dictationVocabulary(terms),
      owner,
      voice?.dictationLanguage
    )
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

  /** Unloads the recognizer now, or when the dictations using it end; resolves once it is gone. */
  unloadModelWhenIdle(): Promise<void> {
    this.state.prewarmGeneration += 1
    const engine = this.state.engine
    if (!engine || sttEngineUsers(this.state, engine).length === 0) {
      return teardownIdleSttEngine(this.state)
    }
    return new Promise((resolve) => engine.onUnloaded.push(resolve))
  }
}
