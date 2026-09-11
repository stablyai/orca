import type { Worker } from 'node:worker_threads'
import type { SttSessionState } from './stt-session-state'
import { waitForSttWorkerStop, type SttWorkerStopOutcome } from './stt-worker-stop'
import { IDLE_WORKER_TEARDOWN_MS } from './stt-session-timeouts'

const STOP_DICTATION_TIMEOUT_MS = 60_000

export async function stopSttDictation(
  state: SttSessionState,
  owner = 'desktop',
  options: { cancelStarting?: boolean } = { cancelStarting: true }
): Promise<void> {
  if (options.cancelStarting !== false && state.startingOwner === owner) {
    state.canceledOwners.add(owner)
  }
  if (!state.worker && !state.cloudSession) {
    return
  }
  const currentOwner = state.activeOwner ?? state.startingOwner
  if (currentOwner && currentOwner !== owner) {
    throw new Error('dictation_owner_mismatch')
  }

  if (state.cloudSession) {
    state.stopping = true
    try {
      const session = state.cloudSession
      state.cloudSession = null
      try {
        const text = await session.finish()
        if (text) {
          state.eventSink?.({ type: 'final', text })
        }
      } catch (error) {
        state.eventSink?.({
          type: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      } finally {
        state.eventSink?.({ type: 'stopped' })
        state.activeModelId = null
        state.activeHotwordsFilePath = undefined
        state.activeOwner = null
        state.eventSink = null
      }
    } finally {
      state.stopping = false
    }
    return
  }

  const worker = state.worker
  if (!worker) {
    return
  }
  if (state.stopInFlight?.worker === worker) {
    if (state.stopInFlight.owner !== owner) {
      throw new Error('dictation_owner_mismatch')
    }
    return state.stopInFlight.promise
  }

  const capturedSink = state.eventSink
  let stopPromise!: Promise<void>
  stopPromise = waitForSttWorkerStop({
    worker,
    capturedSink,
    timeoutMs: STOP_DICTATION_TIMEOUT_MS,
    finish: (outcome) => finishSttWorkerStop(state, worker, outcome)
  }).finally(() => {
    if (state.stopInFlight?.worker === worker && state.stopInFlight.promise === stopPromise) {
      state.stopInFlight = null
    }
  })
  state.stopInFlight = { worker, owner, promise: stopPromise }
  state.stopping = true
  try {
    worker.postMessage({ type: 'stop' })
    await stopPromise
  } finally {
    state.stopping = false
  }
}

function finishSttWorkerStop(
  state: SttSessionState,
  worker: Worker,
  outcome: SttWorkerStopOutcome
): void {
  if (outcome === 'stopped') {
    if (state.worker === worker) {
      state.activeOwner = null
      state.eventSink = null
      scheduleSttIdleTeardown(state)
    }
    return
  }
  cleanupActiveSttWorkerLifecycleListeners(state)
  worker.removeAllListeners()
  if (outcome !== 'exit') {
    void worker.terminate().catch(() => undefined)
  }
  if (state.worker === worker) {
    clearSttWorkerState(state)
  }
}

export async function prepareSttModelForDeletion(
  state: SttSessionState,
  modelId: string
): Promise<void> {
  if (state.startingModelId === modelId || (state.activeOwner && state.activeModelId === modelId)) {
    throw new Error('voice_model_in_use')
  }
  if (state.worker && state.activeModelId === modelId) {
    await teardownIdleSttWorker(state, { ignoreTerminateErrors: false })
    if (state.worker && state.activeModelId === modelId) {
      throw new Error('voice_model_in_use')
    }
  }
}

export function clearSttIdleTeardownTimer(state: SttSessionState): void {
  if (state.idleTeardownTimer) {
    clearTimeout(state.idleTeardownTimer)
    state.idleTeardownTimer = null
  }
}

function scheduleSttIdleTeardown(state: SttSessionState): void {
  clearSttIdleTeardownTimer(state)
  state.idleTeardownTimer = setTimeout(() => {
    void teardownIdleSttWorker(state)
  }, IDLE_WORKER_TEARDOWN_MS)
  state.idleTeardownTimer.unref?.()
}

async function teardownIdleSttWorker(
  state: SttSessionState,
  options: { ignoreTerminateErrors?: boolean } = { ignoreTerminateErrors: true }
): Promise<void> {
  clearSttIdleTeardownTimer(state)
  if (!state.worker || state.activeOwner || state.startingOwner) {
    return
  }
  await teardownSttWorker(state, state.worker, options)
}

export async function teardownSttWorker(
  state: SttSessionState,
  worker: Worker,
  options: { ignoreTerminateErrors?: boolean } = { ignoreTerminateErrors: true }
): Promise<void> {
  clearSttIdleTeardownTimer(state)
  if (state.stopInFlight?.worker === worker) {
    await state.stopInFlight.promise
  }
  try {
    worker.postMessage({ type: 'teardown' })
  } catch {
    // The worker may already have exited on a forced stop path.
  }
  cleanupActiveSttWorkerLifecycleListeners(state)
  worker.removeAllListeners()
  try {
    await worker.terminate()
  } catch (error) {
    if (!options.ignoreTerminateErrors) {
      throw error
    }
  }
  if (state.worker === worker) {
    clearSttWorkerState(state)
  }
}

export function handleSttWorkerFailure(state: SttSessionState, error?: Error): void {
  if (error) {
    state.eventSink?.({ type: 'error', error: String(error) })
  }
  cleanupActiveSttWorkerLifecycleListeners(state)
  clearSttWorkerState(state)
}

export function cleanupActiveSttWorkerLifecycleListeners(state: SttSessionState): void {
  const cleanup = state.cleanupWorkerLifecycleListeners
  state.cleanupWorkerLifecycleListeners = null
  cleanup?.()
}

function clearSttWorkerState(state: SttSessionState): void {
  state.worker = null
  state.activeModelId = null
  state.activeHotwordsFilePath = undefined
  state.activeOwner = null
  state.eventSink = null
}
