import type { Worker } from 'node:worker_threads'
import type { ModelManager } from './model-manager'
import type { CloudSpeechSession } from './cloud-speech-session'
import type { SttEventSink } from './stt-service'

export type StopInFlight = {
  worker: Worker
  owner: string
  promise: Promise<void>
}

/** A cloud stop awaiting its provider; kept so a discard can still abort the upload. */
export type FinishingCloudSession = {
  session: CloudSpeechSession
  owner: string
  sink: SttEventSink | null
  discarded: boolean
  promise: Promise<void>
}

export type SttSessionState = {
  worker: Worker | null
  cloudSession: CloudSpeechSession | null
  finishingCloudSession: FinishingCloudSession | null
  /** Set once the active cloud session's feed failure was reported, so the sink hears it once. */
  cloudFeedFailureReported: boolean
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
    finishingCloudSession: null,
    cloudFeedFailureReported: false,
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
