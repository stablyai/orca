import type { Worker } from 'node:worker_threads'
import type { ModelManager } from './model-manager'
import type { SttEventSink } from './stt-service'

/**
 * A transcription backend that runs outside the sherpa worker — the OpenAI
 * client or the macOS SpeechAnalyzer helper. Both are fed the same audio and
 * both are drained by `finish`.
 */
export type ProviderTranscriptionSession = {
  feedAudio: (samples: Float32Array, sampleRate: number) => void
  finish: () => Promise<string>
}

export type StopInFlight = {
  worker: Worker
  owner: string
  promise: Promise<void>
}

export type SttSessionState = {
  worker: Worker | null
  providerSession: ProviderTranscriptionSession | null
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
    providerSession: null,
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
