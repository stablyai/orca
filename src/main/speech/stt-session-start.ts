import { Worker } from 'node:worker_threads'
import { getCatalogModel } from './model-catalog'
import { createCloudSpeechSession } from './cloud-speech-session-factory'
import { readCloudSpeechApiKey } from './cloud-speech-key-store'
import type { SttEventSink, SttStartOptions } from './stt-service'
import type { SttSessionState } from './stt-session-state'
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
import { resolveModelLanguageHint } from '../../shared/speech-transcription-languages'

export async function startSttDictation(
  state: SttSessionState,
  modelId: string,
  sink: SttEventSink,
  hotwordsFilePath?: string,
  owner = 'desktop',
  options: SttStartOptions = {}
): Promise<void> {
  if (state.starting) {
    if (state.startingOwner !== owner) {
      throw new Error('dictation_already_active')
    }
    return
  }
  // Why: a cloud finish still owns the provider result; even a same-owner restart would race it.
  if (state.finishingCloudSession) {
    throw new Error('dictation_already_active')
  }
  if (
    (state.worker || state.cloudSession || state.stopping) &&
    state.activeOwner &&
    state.activeOwner !== owner
  ) {
    throw new Error('dictation_already_active')
  }
  state.starting = true
  state.startingOwner = owner
  state.startingModelId = modelId
  clearSttIdleTeardownTimer(state)

  try {
    await startSttSession(state, modelId, sink, hotwordsFilePath, owner, options)
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
  owner: string,
  options: SttStartOptions
): Promise<void> {
  const manifest = getCatalogModel(modelId)
  if (!manifest) {
    throw new Error(`Unknown model: ${modelId}`)
  }

  const provider = manifest.provider
  if (provider !== 'local') {
    if (state.worker) {
      const existingWorker = state.worker
      await stopSttDictation(state, owner, { cancelStarting: false })
      await teardownSttWorker(state, existingWorker)
    }
    const modelState = await state.modelManager.getModelState(modelId)
    if (modelState.status !== 'ready') {
      throw new Error(`Model not ready: ${modelState.status}`)
    }
    // Why: a same-owner restart replaces the session; close any open provider socket first.
    state.cloudSession?.cancel()
    state.cloudSession = null
    state.eventSink = sink
    try {
      state.cloudSession = createCloudSpeechSession(manifest, {
        readApiKey: () => readCloudSpeechApiKey(provider),
        // Why: a hint the model cannot honour would fail the request; auto-detect instead.
        language: resolveModelLanguageHint(manifest.transcriptionLanguages, options.language),
        // Why: late provider events after stop must not reach the next dictation's sink.
        sink: (event) => {
          if (state.eventSink === sink) {
            sink(event)
          }
        }
      })
    } catch (error) {
      // Why: a rejected start must not leave a half-claimed session that swallows audio.
      if (state.eventSink === sink) {
        state.eventSink = null
      }
      state.activeOwner = null
      state.activeModelId = null
      throw error
    }
    state.cloudFeedFailureReported = false
    state.activeModelId = modelId
    state.activeHotwordsFilePath = undefined
    sink({ type: 'ready' })
    return
  }

  if (state.cloudSession) {
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
    onExit: () => {
      const stoppedSink = state.stopInFlight?.worker === worker ? null : state.eventSink
      handleSttWorkerFailure(state)
      stoppedSink?.({ type: 'stopped' })
    }
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
