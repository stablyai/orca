import {
  sttEngineUsers,
  type SttEngine,
  type SttSession,
  type SttSessionState
} from './stt-session-state'
import { waitForSttWorkerStop, type SttWorkerStopOutcome } from './stt-worker-stop'
import { STT_WORKER_HUNG_ERROR } from './stt-worker-process'
import { IDLE_WORKER_TEARDOWN_MS } from './stt-session-timeouts'

const STOP_DICTATION_TIMEOUT_MS = 60_000
// A cancel waits only this long behind a busy decode before giving up on it.
const DISCARD_DICTATION_TIMEOUT_MS = 2_000

export function stopSttDictation(
  state: SttSessionState,
  owner = 'desktop',
  options: { discard?: boolean } = {}
): Promise<void> {
  const session = state.sessions.get(owner)
  if (!session) {
    return Promise.resolve()
  }
  if (session.phase === 'starting') {
    // The start sees this once its model is loaded, then drops the session.
    session.canceled = true
    return Promise.resolve()
  }
  if (session.phase === 'stopping') {
    return session.stopPromise ?? Promise.resolve()
  }
  session.phase = 'stopping'
  session.stopPromise = session.cloud
    ? stopCloudSession(state, session, options.discard === true)
    : stopLocalSession(state, session, options.discard === true)
  return session.stopPromise
}

async function stopCloudSession(
  state: SttSessionState,
  session: SttSession,
  discard: boolean
): Promise<void> {
  const cloud = session.cloud!
  if (discard) {
    cloud.cancel()
    releaseSttSession(state, session)
    return
  }
  try {
    const text = await cloud.finish()
    if (text) {
      session.sink({ type: 'final', text })
    }
  } catch (error) {
    session.sink({ type: 'error', error: error instanceof Error ? error.message : String(error) })
  } finally {
    releaseSttSession(state, session)
    session.sink({ type: 'stopped' })
  }
}

function stopLocalSession(
  state: SttSessionState,
  session: SttSession,
  discard: boolean
): Promise<void> {
  const engine = session.engine!
  const stopped = waitForSttWorkerStop({
    worker: engine.worker,
    streamId: session.streamId,
    capturedSink: session.sink,
    timeoutMs: discard ? DISCARD_DICTATION_TIMEOUT_MS : STOP_DICTATION_TIMEOUT_MS,
    discard,
    finish: (outcome) => finishLocalStop(state, session, engine, outcome, discard)
  })
  engine.worker.postMessage({ type: discard ? 'discard' : 'stop', streamId: session.streamId })
  return stopped
}

function finishLocalStop(
  state: SttSessionState,
  session: SttSession,
  engine: SttEngine,
  outcome: SttWorkerStopOutcome,
  discard: boolean
): void {
  releaseSttSession(state, session)
  if (outcome === 'stopped') {
    return
  }
  // A cancel stuck behind another session's decode must not kill that session; the stream dies with the process later.
  if (outcome === 'timeout' && discard && sttEngineUsers(state, engine).length > 0) {
    return
  }
  failSttEngine(state, engine, STT_WORKER_HUNG_ERROR)
}

/** Drops a session; a failed start also frees whatever stream its early audio opened. */
export function releaseSttSession(state: SttSessionState, session: SttSession): void {
  if (state.sessions.get(session.owner) === session) {
    state.sessions.delete(session.owner)
  }
  const engine = session.engine
  if (!engine || engine.dead) {
    return
  }
  if (session.phase === 'starting') {
    engine.worker.postMessage({ type: 'discard', streamId: session.streamId })
  }
  if (state.engine === engine && sttEngineUsers(state, engine).length === 0) {
    scheduleSttIdleTeardown(state)
  }
}

/** Ends every live session on a dead or hung process; stopping ones report through their own stop. */
export function failSttEngine(state: SttSessionState, engine: SttEngine, error: string): void {
  if (engine.dead) {
    return
  }
  engine.dead = true
  engine.detach()
  if (state.engine === engine) {
    state.engine = null
    clearSttIdleTeardownTimer(state)
  }
  for (const session of sttEngineUsers(state, engine)) {
    if (session.phase !== 'active') {
      continue
    }
    state.sessions.delete(session.owner)
    session.sink({ type: 'error', error })
    session.sink({ type: 'stopped' })
  }
  void engine.worker.terminate().catch(() => undefined)
}

export async function prepareSttModelForDeletion(
  state: SttSessionState,
  modelId: string
): Promise<void> {
  if ([...state.sessions.values()].some((session) => session.modelId === modelId)) {
    throw new Error('voice_model_in_use')
  }
  const engine = state.engine
  if (engine?.modelId === modelId) {
    await teardownSttEngine(state, engine, { ignoreTerminateErrors: false })
  }
  if (state.engine?.modelId === modelId) {
    throw new Error('voice_model_in_use')
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
    state.idleTeardownTimer = null
    const engine = state.engine
    if (engine && sttEngineUsers(state, engine).length === 0) {
      void teardownSttEngine(state, engine)
    }
  }, IDLE_WORKER_TEARDOWN_MS)
  state.idleTeardownTimer.unref?.()
}

/** Only for a process no session uses. */
export async function teardownSttEngine(
  state: SttSessionState,
  engine: SttEngine,
  options: { ignoreTerminateErrors?: boolean } = { ignoreTerminateErrors: true }
): Promise<void> {
  if (state.engine === engine) {
    state.engine = null
    clearSttIdleTeardownTimer(state)
  }
  engine.dead = true
  engine.detach()
  try {
    engine.worker.postMessage({ type: 'teardown' })
  } catch {
    // The process may already have exited.
  }
  try {
    await engine.worker.terminate()
  } catch (error) {
    if (!options.ignoreTerminateErrors) {
      throw error
    }
  }
}
