import { voiceModelUnloadDelayMs } from '../../shared/voice-model-unload'
import type { ModelManager } from './model-manager'
import type { OpenAiTranscriptionSession } from './openai-transcription-client'
import type { SttEventSink } from './stt-service'
import type { SpawnSttWorkerProcess, SttWorkerProcess } from './stt-worker-process'

// Each session holds its own stream on the shared recognizer; this bounds decode load and memory.
export const MAX_STT_SESSIONS = 4

export type SttRecognizerConfig = {
  modelId: string
  language: string | undefined
}

/** One loaded recognizer process, shared by every local session with the same config. */
export type SttEngine = SttRecognizerConfig & {
  worker: SttWorkerProcess
  ready: Promise<void>
  detach: () => void
  /** Torn down on purpose, so a load it cut short is not a failure of the model. */
  retired: boolean
  /** Called once this process is gone; set when it must not outlive its last dictation. */
  onUnloaded: (() => void)[]
}

export type SttSession = {
  owner: string
  streamId: string
  sink: SttEventSink
  /** null for cloud models, which load no recognizer. */
  config: SttRecognizerConfig | null
  modelId: string
  /** Spellings this dictation's stream tells the engine to expect. */
  vocabulary: string[]
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
  /** null keeps an idle recognizer loaded; 0 unloads it as soon as its last dictation ends. */
  idleUnloadMs: number | null
  /** Pre-warm skips a model that failed to load until a dictation loads it, so focus does not retry it forever. */
  prewarmFailedModelId: string | null
  /** Bumped by each pre-warm and unload; an older pre-warm that sees a newer one stops. */
  prewarmGeneration: number
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
    idleTeardownTimer: null,
    idleUnloadMs: voiceModelUnloadDelayMs(undefined),
    prewarmFailedModelId: null,
    prewarmGeneration: 0
  }
}

export function sameSttRecognizerConfig(a: SttRecognizerConfig, b: SttRecognizerConfig): boolean {
  return a.modelId === b.modelId && a.language === b.language
}

export function sttEngineUsers(state: SttSessionState, engine: SttEngine): SttSession[] {
  return [...state.sessions.values()].filter((session) => session.engine === engine)
}
