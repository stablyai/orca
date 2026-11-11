import { errorMessage } from '../../shared/error-message'
import {
  sttEngineUsers,
  type SttEngine,
  type SttSession,
  type SttSessionState
} from './stt-session-state'
import { waitForSttWorkerStop, type SttWorkerStopOutcome } from './stt-worker-stop'
import { STT_WORKER_HUNG_ERROR } from './stt-worker-process'
import { LOCAL_DICTATION_STOP_TIMEOUT_MS } from '../../shared/dictation-finish-deadlines'

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
    // The start sees it was dropped once its model is loaded, which a quick retry can then reuse.
    state.sessions.delete(owner)
    return Promise.resolve()
  }
  if (session.phase === 'stopping') {
    // A cancel after Finish still drops the work whose text it would throw away.
    if (options.discard) {
      session.cloud?.cancel()
      if (session.engine) {
        discardLocalStream(state, session.engine, session.streamId)
      }
    }
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
    session.sink({ type: 'error', error: errorMessage(error) })
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
    sink: session.sink,
    timeoutMs: discard ? DISCARD_DICTATION_TIMEOUT_MS : LOCAL_DICTATION_STOP_TIMEOUT_MS,
    discard,
    finish: (outcome) => finishLocalStop(state, session, engine, outcome, discard)
  })
  if (discard) {
    discardLocalStream(state, engine, session.streamId)
  } else {
    engine.worker.postMessage({ type: 'stop', streamId: session.streamId })
  }
  return stopped
}

/**
 * The speech process answers a cancel at once and skips the stream's queued work, but a decode already running
 * finishes first. One that outlasts the grace (hung in native code, or just long) restarts the process, as a
 * cancel always did, so the next dictation isn't stuck behind it.
 */
function discardLocalStream(state: SttSessionState, engine: SttEngine, streamId: string): void {
  const reached = waitForSttWorkerMessage(
    engine.worker,
    (message) => message.type === 'discarded' && message.streamId === streamId,
    DISCARD_DICTATION_TIMEOUT_MS
  )
  engine.worker.postMessage({ type: 'discard', streamId })
  const draining = reached.then(async (inTime) => {
    // Another device's decode may hold the queue; never kill its dictation.
    if (!inTime && state.engine === engine && sttEngineUsers(state, engine).length === 0) {
      // A failed kill must not fail the dictation waiting on this; it starts on a fresh process either way.
      await teardownSttEngine(state, engine).catch((error: unknown) =>
        console.warn('[speech] Could not stop the busy speech process after a cancel:', error)
      )
    }
  })
  engine.draining = draining
  void draining.finally(() => {
    if (engine.draining === draining) {
      engine.draining = null
    }
  })
}

/** Resolves true when the worker sends a matching message (or exits), false after `timeoutMs`. */
function waitForSttWorkerMessage(
  worker: SttEngine['worker'],
  matches: (message: { type: string; streamId?: string }) => boolean,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (inTime: boolean): void => {
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('exit', onExit)
      resolve(inTime)
    }
    const onMessage = (message: { type: string; streamId?: string }): void => {
      if (matches(message)) {
        settle(true)
      }
    }
    const onExit = (): void => settle(true)
    const timer = setTimeout(() => settle(false), timeoutMs)
    timer.unref?.()
    worker.on('message', onMessage)
    worker.on('exit', onExit)
  })
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
  if (!engine || state.engine !== engine) {
    return
  }
  if (session.phase === 'starting') {
    engine.worker.postMessage({ type: 'discard', streamId: session.streamId })
  }
  if (sttEngineUsers(state, engine).length === 0) {
    if (engine.onUnloaded.length > 0) {
      void teardownSttEngine(state, engine)
    } else {
      scheduleSttIdleTeardown(state)
    }
  }
}

function notifyUnloaded(engine: SttEngine): void {
  for (const unloaded of engine.onUnloaded.splice(0)) {
    unloaded()
  }
}

/** Ends every live session on a dead or hung process; stopping ones report through their own stop. */
export function failSttEngine(state: SttSessionState, engine: SttEngine, error: string): void {
  if (state.engine !== engine) {
    return
  }
  state.engine = null
  clearSttIdleTeardownTimer(state)
  engine.detach()
  for (const session of sttEngineUsers(state, engine)) {
    if (session.phase !== 'active') {
      continue
    }
    state.sessions.delete(session.owner)
    session.sink({ type: 'error', error })
    session.sink({ type: 'stopped' })
  }
  void engine.worker.terminate().finally(() => notifyUnloaded(engine))
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
    await teardownSttEngine(state, engine)
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

export function scheduleSttIdleTeardown(state: SttSessionState): void {
  clearSttIdleTeardownTimer(state)
  if (state.idleUnloadMs === null) {
    return
  }
  state.idleTeardownTimer = setTimeout(() => {
    state.idleTeardownTimer = null
    void teardownIdleSttEngine(state)
  }, state.idleUnloadMs)
  state.idleTeardownTimer.unref?.()
}

/** Frees the loaded recognizer (only one with this model, when given) if no session uses it. */
export async function teardownIdleSttEngine(
  state: SttSessionState,
  modelId?: string
): Promise<void> {
  const engine = state.engine
  if (
    engine &&
    (modelId === undefined || engine.modelId === modelId) &&
    sttEngineUsers(state, engine).length === 0
  ) {
    await teardownSttEngine(state, engine)
  }
}

/** Only for a process no session uses. */
export async function teardownSttEngine(state: SttSessionState, engine: SttEngine): Promise<void> {
  engine.retired = true
  if (state.engine === engine) {
    state.engine = null
    clearSttIdleTeardownTimer(state)
  }
  engine.detach()
  // Resolves once the process is gone, so its model files are free to delete.
  await engine.worker.terminate()
  notifyUnloaded(engine)
}
