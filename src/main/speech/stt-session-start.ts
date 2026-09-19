import { Worker } from 'node:worker_threads'
import { AppleSpeechSession } from './apple-speech-session'
import { getCatalogModel } from './model-catalog'
import { OpenAiTranscriptionSession } from './openai-transcription-client'
import { readOpenAiSpeechApiKey } from './openai-api-key-store'
import type { SttEventSink } from './stt-service'
import type { ProviderTranscriptionSession, SttSessionState } from './stt-session-state'
import {
  clearSttIdleTeardownTimer,
  cleanupActiveSttWorkerLifecycleListeners,
  handleSttWorkerFailure,
  stopSttDictation,
  teardownSttWorker
} from './stt-session-stop'
import { getSherpaModulePath, getSttWorkerPath } from './stt-worker-paths'
import {
  attachSttWorkerLifecycle,
  initializeSttWorker,
  waitForSttWorkerReady
} from './stt-worker-startup'
import { START_DICTATION_TIMEOUT_MS } from './stt-session-timeouts'

export async function startSttDictation(
  state: SttSessionState,
  modelId: string,
  sink: SttEventSink,
  hotwordsFilePath?: string,
  owner = 'desktop'
): Promise<void> {
  if (state.starting) {
    if (state.startingOwner !== owner) {
      throw new Error('dictation_already_active')
    }
    return
  }
  if ((state.worker || state.providerSession) && state.activeOwner && state.activeOwner !== owner) {
    throw new Error('dictation_already_active')
  }
  state.starting = true
  state.startingOwner = owner
  state.startingModelId = modelId
  clearSttIdleTeardownTimer(state)

  try {
    await startSttSession(state, modelId, sink, hotwordsFilePath, owner)
    if (state.canceledOwners.delete(owner)) {
      await stopSttDictation(state, owner, { cancelStarting: false })
      throw new Error('dictation_canceled')
    }
    state.activeOwner = owner
  } finally {
    state.starting = false
    state.startingOwner = null
    state.startingModelId = null
    state.canceledOwners.delete(owner)
  }
}

async function startSttSession(
  state: SttSessionState,
  modelId: string,
  sink: SttEventSink,
  hotwordsFilePath: string | undefined,
  owner: string
): Promise<void> {
  const manifest = getCatalogModel(modelId)
  if (!manifest) {
    throw new Error(`Unknown model: ${modelId}`)
  }

  if (manifest.provider === 'openai' || manifest.provider === 'apple') {
    await startProviderSession(state, manifest.provider, modelId, sink, owner)
    return
  }

  if (state.providerSession) {
    await stopSttDictation(state, owner, { cancelStarting: false })
  }
  const reusableWorker = state.worker
  if (
    reusableWorker &&
    state.activeModelId === modelId &&
    state.activeHotwordsFilePath === hotwordsFilePath &&
    state.stopInFlight?.worker !== reusableWorker
  ) {
    if (!state.activeOwner) {
      const modelState = await state.modelManager.getModelState(modelId)
      if (modelState.status !== 'ready') {
        await teardownSttWorker(state, reusableWorker)
        throw new Error(`Model not ready: ${modelState.status}`)
      }
    }
    if (
      state.worker === reusableWorker &&
      state.activeModelId === modelId &&
      state.activeHotwordsFilePath === hotwordsFilePath &&
      state.stopInFlight?.worker !== reusableWorker
    ) {
      state.eventSink = sink
      sink({ type: 'ready' })
      return
    }
  }

  if (state.worker) {
    const existingWorker = state.worker
    await stopSttDictation(state, owner, { cancelStarting: false })
    await teardownSttWorker(state, existingWorker)
  }
  const modelState = await state.modelManager.getModelState(modelId)
  if (modelState.status !== 'ready') {
    throw new Error(`Model not ready: ${modelState.status}`)
  }

  const worker = new Worker(getSttWorkerPath(), {
    workerData: { sherpaModulePath: getSherpaModulePath() }
  })
  state.worker = worker
  state.activeModelId = modelId
  state.activeHotwordsFilePath = hotwordsFilePath
  state.eventSink = sink

  const readyPromise = waitForSttWorkerReady(worker, START_DICTATION_TIMEOUT_MS)
  state.cleanupWorkerLifecycleListeners = attachSttWorkerLifecycle({
    worker,
    isCurrent: () => state.worker === worker,
    onMessage: (event) => state.eventSink?.(event),
    onError: (error) => handleSttWorkerFailure(state, error),
    onExit: () => handleSttWorkerFailure(state)
  })
  initializeSttWorker(worker, {
    modelDir: state.modelManager.getModelDir(modelId),
    modelType: manifest.type,
    streaming: manifest.streaming,
    sampleRate: manifest.sampleRate,
    files: manifest.files ?? [],
    hotwordsFilePath,
    modelingUnit: manifest.modelingUnit
  })

  try {
    await readyPromise
  } catch (error) {
    cleanupActiveSttWorkerLifecycleListeners(state)
    worker.removeAllListeners()
    void worker.terminate()
    if (state.worker === worker) {
      handleSttWorkerFailure(state)
    }
    throw error
  }
}

/**
 * Starts a backend that needs no sherpa worker. Apple's helper streams its own
 * partial and final segments, so the sink is wired up before it is launched.
 */
async function startProviderSession(
  state: SttSessionState,
  provider: 'openai' | 'apple',
  modelId: string,
  sink: SttEventSink,
  owner: string
): Promise<void> {
  if (state.worker) {
    const existingWorker = state.worker
    await stopSttDictation(state, owner, { cancelStarting: false })
    await teardownSttWorker(state, existingWorker)
  } else if (state.providerSession) {
    await stopSttDictation(state, owner, { cancelStarting: false })
  }
  const modelState = await state.modelManager.getModelState(modelId)
  if (modelState.status !== 'ready') {
    throw new Error(`Model not ready: ${modelState.status}`)
  }

  state.eventSink = sink
  state.activeModelId = modelId
  state.activeHotwordsFilePath = undefined
  if (provider === 'openai') {
    state.providerSession = new OpenAiTranscriptionSession(modelId, readOpenAiSpeechApiKey)
    sink({ type: 'ready' })
    return
  }

  // Why registered before it starts: the helper can report a failure in the
  // same stdout chunk as its ready line, and the stop that failure triggers
  // has to find the session it needs to tear down.
  const session = new AppleSpeechSession((event) => state.eventSink?.(event))
  state.providerSession = session
  try {
    await session.start()
  } catch (error) {
    clearFailedProviderSession(state, session)
    throw error
  }
  if (state.providerSession !== session) {
    throw new Error('dictation_canceled')
  }
  sink({ type: 'ready' })
}

function clearFailedProviderSession(
  state: SttSessionState,
  session: ProviderTranscriptionSession
): void {
  if (state.providerSession !== session) {
    return
  }
  state.providerSession = null
  state.activeModelId = null
  state.eventSink = null
}
