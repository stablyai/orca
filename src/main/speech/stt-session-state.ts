import type { ModelManager } from './model-manager'
import type { OpenAiTranscriptionSession } from './openai-transcription-client'
import type { SttEventSink } from './stt-service'
import type { SpawnSttWorkerProcess, SttWorkerProcess } from './stt-worker-process'

// Each session holds its own stream on the shared recognizer; this bounds decode load and memory.
export const MAX_STT_SESSIONS = 4

export type SttRecognizerConfig = {
  modelId: string
  hotwordsFilePath: string | undefined
  language: string | undefined
}

/** One loaded recognizer process, shared by every local session with the same config. */
export type SttEngine = SttRecognizerConfig & {
  worker: SttWorkerProcess
  ready: Promise<void>
  detach: () => void
}

export type SttSession = {
  owner: string
  streamId: string
  sink: SttEventSink
  /** null for cloud models, which load no recognizer. */
  config: SttRecognizerConfig | null
  modelId: string
  engine: SttEngine | null
  cloud: OpenAiTranscriptionSession | null
  phase: 'starting' | 'active' | 'stopping'
  stopPromise: Promise<void> | null
}

export type SttSessionState = {
  spawnWorker: SpawnSttWorkerProcess
  modelManager: ModelManager
  engine: SttEngine | null
  sessions: Map<string, SttSession>
  nextStreamId: number
  idleTeardownTimer: NodeJS.Timeout | null
}

export function createSttSessionState(
  modelManager: ModelManager,
  spawnWorker: SpawnSttWorkerProcess
): SttSessionState {
  return {
    spawnWorker,
    modelManager,
    engine: null,
    sessions: new Map(),
    nextStreamId: 0,
    idleTeardownTimer: null
  }
}

export function sameSttRecognizerConfig(a: SttRecognizerConfig, b: SttRecognizerConfig): boolean {
  return (
    a.modelId === b.modelId &&
    a.hotwordsFilePath === b.hotwordsFilePath &&
    a.language === b.language
  )
}

export function sttEngineUsers(state: SttSessionState, engine: SttEngine): SttSession[] {
  return [...state.sessions.values()].filter((session) => session.engine === engine)
}
