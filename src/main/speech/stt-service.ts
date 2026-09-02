import type { ModelManager } from './model-manager'
import { startSttDictation } from './stt-session-start'
import { createSttSessionState, type SttSessionState } from './stt-session-state'
import { prepareSttModelForDeletion, stopSttDictation } from './stt-session-stop'

export { IDLE_WORKER_TEARDOWN_MS, START_DICTATION_TIMEOUT_MS } from './stt-session-timeouts'

export type SttEvent =
  | { type: 'ready' }
  | { type: 'partial'; text?: string }
  | { type: 'final'; text?: string }
  | { type: 'stopped' }
  | { type: 'error'; error?: string }

export type SttEventSink = (event: SttEvent) => void

export class SttService {
  private readonly state: SttSessionState

  constructor(modelManager: ModelManager) {
    this.state = createSttSessionState(modelManager)
  }

  startDictation(
    modelId: string,
    sink: SttEventSink,
    hotwordsFilePath?: string,
    owner = 'desktop'
  ): Promise<void> {
    return startSttDictation(this.state, modelId, sink, hotwordsFilePath, owner)
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
      this.state.cloudSession.feedAudio(samples, sampleRate)
      return
    }
    this.state.worker?.postMessage({ type: 'feed', samples, sampleRate }, [
      samples.buffer as ArrayBuffer
    ])
  }

  stopDictation(
    owner = 'desktop',
    options: { cancelStarting?: boolean } = { cancelStarting: true }
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
