import type { CloudSpeechSession } from './cloud-speech-session'
import type { ModelManager } from './model-manager'
import { startSttDictation } from './stt-session-start'
import { createSttSessionState, type SttSessionState } from './stt-session-state'
import {
  prepareSttModelForDeletion,
  stopSttDictation,
  type SttStopOptions
} from './stt-session-stop'

export { IDLE_WORKER_TEARDOWN_MS, START_DICTATION_TIMEOUT_MS } from './stt-session-timeouts'

export type SttEvent =
  | { type: 'ready' }
  | { type: 'partial'; text?: string }
  | { type: 'final'; text?: string }
  | { type: 'stopped' }
  | { type: 'error'; error?: string }

export type SttEventSink = (event: SttEvent) => void

export type SttStartOptions = {
  /** Cloud-only spoken-language hint (ISO 639-1); undefined lets the provider detect. */
  language?: string
}

export class SttService {
  private readonly state: SttSessionState

  constructor(modelManager: ModelManager) {
    this.state = createSttSessionState(modelManager)
  }

  startDictation(
    modelId: string,
    sink: SttEventSink,
    hotwordsFilePath?: string,
    owner = 'desktop',
    options: SttStartOptions = {}
  ): Promise<void> {
    return startSttDictation(this.state, modelId, sink, hotwordsFilePath, owner, options)
  }

  feedAudio(samples: Float32Array, sampleRate: number, owner = 'desktop'): void {
    if (this.state.stopping) {
      return
    }
    const currentOwner = this.state.activeOwner ?? this.state.startingOwner
    if (!currentOwner) {
      return
    }
    if (currentOwner !== owner) {
      throw new Error('dictation_owner_mismatch')
    }
    if (this.state.cloudSession) {
      this.feedCloudAudio(this.state.cloudSession, samples, sampleRate)
      return
    }
    this.state.worker?.postMessage({ type: 'feed', samples, sampleRate }, [
      samples.buffer as ArrayBuffer
    ])
  }

  private feedCloudAudio(
    session: CloudSpeechSession,
    samples: Float32Array,
    sampleRate: number
  ): void {
    try {
      session.feedAudio(samples, sampleRate)
    } catch (error) {
      // Why: desktop capture ignores feed rejections, so the sink is the only place the user sees it.
      if (!this.state.cloudFeedFailureReported) {
        this.state.cloudFeedFailureReported = true
        this.state.eventSink?.({
          type: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }
  }

  stopDictation(
    owner = 'desktop',
    options: SttStopOptions = { cancelStarting: true }
  ): Promise<void> {
    return stopSttDictation(this.state, owner, options)
  }

  isActive(): boolean {
    return this.state.worker !== null || this.state.cloudSession !== null
  }

  getActiveModelId(): string | null {
    return this.state.activeModelId
  }

  prepareModelForDeletion(modelId: string): Promise<void> {
    return prepareSttModelForDeletion(this.state, modelId)
  }
}
