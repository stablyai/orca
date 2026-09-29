import type { Worker } from 'node:worker_threads'
import type { ModelManager } from './model-manager'
import type { CloudTranscriptionSession } from './cloud-transcription-audio'
import type { SttEventSink } from './stt-service'

export type StopInFlight = {
  worker: Worker
  owner: string
  promise: Promise<void>
}

export type SttSessionState = {
  worker: Worker | null
  cloudSession: CloudTranscriptionSession | null
  cloudStopInFlight: Promise<void> | null
  modelManager: ModelManager
  activeModelId: string | null
  activeHotwordsFilePath: string | undefined
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

export function createSttSessionState(modelManager: ModelManager): SttSessionState {
  return {
    worker: null,
    cloudSession: null,
    cloudStopInFlight: null,
    modelManager,
    activeModelId: null,
    activeHotwordsFilePath: undefined,
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
