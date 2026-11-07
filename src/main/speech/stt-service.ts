import type { ModelManager } from './model-manager'
import type { SpawnSttWorkerProcess } from './stt-worker-process'
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
    session.engine?.worker.postMessage({
      type: 'feed',
      streamId: session.streamId,
      samples,
      sampleRate
    })
    return false
  }

  stopDictation(owner = 'desktop', options: { discard?: boolean } = {}): Promise<void> {
    return stopSttDictation(this.state, owner, options)
  }

  prepareModelForDeletion(modelId: string): Promise<void> {
    return prepareSttModelForDeletion(this.state, modelId)
  }
}
