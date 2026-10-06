import {
  agentSessionFailureFact,
  providerDiagnosticOf,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  providerExitObserved,
  providerStartupFailureFact
} from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { claudeDispatchRejection } from './claude-structured-dispatch-content'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { settledClaudeTurnEndLeaf } from './claude-structured-resume-point'
import {
  claudeRootExitObserved,
  finishClaudeCloseAfterExit,
  settleClaudeExitedSession
} from './claude-structured-session-close'
import { failClaudeStartup } from './claude-structured-session-startup-state'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export type ClaudeSettledExit = { error: Error; failure: SubmissionRejectionFact }

export type ClaudeExitLifecycle = {
  sessions: Map<string, ClaudeSession>
  exits: Map<string, ClaudeSessionExit>
  /** A settled exit's diagnostic and why it ended, kept for a send admitted before the host heard
   *  of the exit. */
  settledExits: Map<string, ClaudeSettledExit>
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistHandle' | 'now' | 'onEvent' | 'logger'>
  emit: (session: ClaudeSession, event: ClaudeStructuredSessionEvent) => void
}

export function observeClaudeSessionExit(
  lifecycle: ClaudeExitLifecycle,
  sessionId: string,
  attempt: ClaudeAcquisitionAttempt,
  error: Error
): void {
  const session = lifecycle.sessions.get(sessionId)
  if (!session || session.connection !== attempt.connection) {
    settleRetainedClaudeRootExit(lifecycle, sessionId, attempt.connection)
    return
  }
  lifecycle.sessions.delete(sessionId)
  // Not marked here: startup and journal faults end the session this way too. The child's own
  // exit arrives already marked by the connection's exit callback.
  failClaudeStartup(session, error)
  // Re-enter the provider's close ladder before publishing lifecycle recovery.
  // An exit callback is root evidence only; the retained tree proof must run
  // before the host releases and reacquires this exact child.
  const closePromise = session.connection.close().catch(() => false)
  const exit: ClaudeSessionExit = {
    connection: session.connection,
    session,
    error,
    closePromise
  }
  lifecycle.exits.set(sessionId, exit)
  exit.publication = closePromise
    .then((proven) => {
      // A first-hand root exit is final like a proven one: the owner releases the lease on it.
      if (!proven && !claudeRootExitObserved(session.connection)) {
        reportClaudeUnprovenEnd(lifecycle, sessionId, exit)
        return undefined
      }
      return settleClaudeUnexpectedExit(lifecycle, sessionId, exit)
    })
    .catch(() => undefined)
}

/** The root exited after a close began: that close settles it, or one the adapter began after
 *  letting the session go ends the exit it kept. */
export function finishClaudeExitedClose(
  lifecycle: ClaudeExitLifecycle,
  sessionId: string,
  connection: ClaudeStreamJsonConnection | null,
  afterClose: (close: () => Promise<boolean>) => Promise<boolean>
): void {
  settleRetainedClaudeRootExit(lifecycle, sessionId, connection)
  finishClaudeCloseAfterExit({
    sessions: lifecycle.sessions,
    sessionId,
    connection,
    deps: lifecycle.deps,
    afterClose
  })
}

/** The root of an exit whose close could not prove it gone has now exited: the end it reported
 *  unproven is final. Only the retained exit's own connection reports it, and only once that
 *  exit's first close has answered, which publishes the end itself when it saw the root go. */
function settleRetainedClaudeRootExit(
  lifecycle: ClaudeExitLifecycle,
  sessionId: string,
  connection: ClaudeStreamJsonConnection | null
): void {
  const exit = lifecycle.exits.get(sessionId)
  if (!exit || exit.connection !== connection) {
    return
  }
  const published = exit.publication ?? Promise.resolve()
  exit.publication = published.then(() =>
    lifecycle.exits.get(sessionId) === exit && claudeRootExitObserved(exit.connection)
      ? settleClaudeUnexpectedExit(lifecycle, sessionId, exit).catch(() => undefined)
      : undefined
  )
}

/** Never silence: the host keeps the child on record, closing, until its exit is proven or seen. */
function reportClaudeUnprovenEnd(
  lifecycle: ClaudeExitLifecycle,
  sessionId: string,
  exit: ClaudeSessionExit
): void {
  if (lifecycle.exits.get(sessionId) !== exit) {
    return
  }
  lifecycle.deps.onEvent?.({
    type: 'end-unproven',
    sessionId,
    reason: exit.error.message,
    failure: claudeExitFailure(exit),
    fence: exit.session.fence,
    acquisitionGeneration: exit.session.acquisitionGeneration
  })
}

/** A start that never landed says why it failed. After it landed, only the child's own exit blames
 *  the provider; an Orca fault that closed it is Orca's. */
function claudeExitFailure(exit: Pick<ClaudeSessionExit, 'session' | 'error'>) {
  return exit.session.startup.state !== 'proven'
    ? providerStartupFailureFact(exit.session.startup.failure ?? exit.error)
    : providerExitObserved(exit.error)
      ? agentSessionFailureFact('providerExited', { detail: providerDiagnosticOf(exit.error) })
      : agentSessionFailureFact('hostFault')
}

/** Lifecycle recovery is published only after the close ladder ran and proved the tree gone or
 *  observed the root's own exit. */
export function settleClaudeUnexpectedExit(
  lifecycle: ClaudeExitLifecycle,
  sessionId: string,
  exit: ClaudeSessionExit
): Promise<void> {
  const { exits, deps } = lifecycle
  exit.settlementPromise ??= (async () => {
    exit.session.unbindReadingControl?.()
    if (exits.get(sessionId) !== exit) {
      settleClaudeExitedSession(exit.session)
      return
    }
    // Persist the last completed turn before publishing the lifecycle
    // event that lets the host release and reacquire this exact child.
    await persistClaudeSessionHandle(sessionId, exit.session, deps).catch((error: unknown) => {
      // Recovery still publishes: the record keeps its last durable point, and the loss is logged.
      console.warn('[claude-resume-point] exit cursor was not persisted:', { sessionId, error })
    })
    if (exits.get(sessionId) !== exit) {
      settleClaudeExitedSession(exit.session)
      return
    }
    exits.delete(sessionId)
    lifecycle.settledExits.set(sessionId, { error: exit.error, failure: claudeExitFailure(exit) })
    const ended: ClaudeStructuredSessionEvent = {
      type: 'ended',
      sessionId,
      reason: exit.error.message,
      failure: claudeExitFailure(exit),
      cause: 'unexpected-exit',
      fence: exit.session.fence,
      acquisitionGeneration: exit.session.acquisitionGeneration,
      observedAt: deps.now?.() ?? Date.now(),
      ...(exit.session.startup.state === 'proven' ? {} : { startupUnproven: true })
    }
    try {
      lifecycle.emit(exit.session, ended)
    } finally {
      settleClaudeExitedSession(exit.session)
    }
  })()
  return exit.settlementPromise
}

/** A message for a child this adapter no longer serves was never written, so it is rejected with
 *  why that child ended, never left in doubt. */
function rejectClaudeDetachedDispatch(
  lifecycle: Pick<ClaudeExitLifecycle, 'exits' | 'settledExits'>,
  sessionId: string
): AgentSessionDispatchOutcome {
  const exit = lifecycle.exits.get(sessionId)
  const failure = exit
    ? claudeExitFailure(exit)
    : (lifecycle.settledExits.get(sessionId)?.failure ?? agentSessionFailureFact('providerExited'))
  return { state: 'rejected', ...claudeDispatchRejection(failure) }
}

/** Runs `run` on the live session, or rejects what was meant for a child this adapter let go of. */
export async function withClaudeSessionOrRejected<T>(
  lifecycle: Pick<ClaudeExitLifecycle, 'sessions' | 'exits' | 'settledExits'>,
  sessionId: string,
  run: (session: ClaudeSession) => Promise<T>
): Promise<T | AgentSessionDispatchOutcome> {
  const session = lifecycle.sessions.get(sessionId)
  return session ? run(session) : rejectClaudeDetachedDispatch(lifecycle, sessionId)
}

/** Wait for each first-hand exit's publication, including exits observed while waiting. */
export async function drainClaudeObservedExits(
  exits: Map<string, ClaudeSessionExit>
): Promise<void> {
  const awaited = new Set<Promise<void>>()
  for (;;) {
    const pending = [...exits.values()]
      .map((exit) => exit.publication)
      .filter(
        (publication): publication is Promise<void> =>
          publication !== undefined && !awaited.has(publication)
      )
    if (pending.length === 0) {
      return
    }
    for (const publication of pending) {
      awaited.add(publication)
    }
    await Promise.all(pending)
  }
}

export async function persistClaudeSessionHandle(
  sessionId: string,
  session: ClaudeSession,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistHandle'>
): Promise<void> {
  const leafUuid = await settledClaudeTurnEndLeaf(session)
  await deps.persistHandle?.({
    sessionId,
    providerSessionId: session.providerSessionId,
    leafUuid,
    fence: session.fence
  })
}
