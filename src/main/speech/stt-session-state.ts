import type { ModelManager } from './model-manager'
import type { OpenAiTranscriptionSession } from './openai-transcription-client'
import type { SttEventSink } from './stt-service'
import type { SpawnSttWorkerProcess, SttWorkerProcess } from './stt-worker-process'

export type StopInFlight = {
  worker: SttWorkerProcess
  owner: string
  promise: Promise<void>
}

export type SttSessionState = {
  spawnWorker: SpawnSttWorkerProcess
  worker: SttWorkerProcess | null
  cloudSession: OpenAiTranscriptionSession | null
  cloudStopInFlight: { session: OpenAiTranscriptionSession; promise: Promise<void> } | null
  modelManager: ModelManager
  activeModelId: string | null
  activeHotwordsFilePath: string | undefined
  activeLanguage: string | undefined
  activeOwner: string | null
  startingOwner: string | null
  startingModelId: string | null
  starting: boolean
  canceledOwners: Set<string>
  eventSink: SttEventSink | null
  idleTeardownTimer: NodeJS.Timeout | null
  stopInFlight: StopInFlight | null
  stopping: boolean
  cleanupWorkerLifecycleListeners: (() => void) | null
}

export function createSttSessionState(
  modelManager: ModelManager,
  spawnWorker: SpawnSttWorkerProcess
): SttSessionState {
  return {
    spawnWorker,
    worker: null,
    cloudSession: null,
    cloudStopInFlight: null,
    modelManager,
    activeModelId: null,
    activeHotwordsFilePath: undefined,
    activeLanguage: undefined,
    activeOwner: null,
    startingOwner: null,
    startingModelId: null,
    starting: false,
    canceledOwners: new Set(),
    eventSink: null,
    idleTeardownTimer: null,
    stopInFlight: null,
    stopping: false,
    cleanupWorkerLifecycleListeners: null
  }
}
