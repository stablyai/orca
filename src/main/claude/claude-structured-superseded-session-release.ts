import {
  cancelClaudeAcquisitionAttempt,
  type ClaudeAcquireCallbacks,
  type ClaudeAcquisitionAttempt,
  type ClaudeAcquisitionRegistry,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'
import {
  claudeAcquisitionCleanupError,
  closeClaudePublishedSessionForDeps
} from './claude-structured-session-close'
import { AgentSessionAcquisitionExitUnprovenError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

/**
 * Everything a new acquisition must prove gone before it may spawn its own child: the acquisition
 * attempt it superseded, the published session that attempt owned, and any first-hand exit still
 * holding an unproven cleanup obligation.
 *
 * Answers the session the caller should resume from — the closed session's durable head, or the
 * retained exit's, whichever survived. An unproven stop throws rather than reporting absence:
 * losing contact with a child is never evidence that it died.
 */
export async function releaseSupersededClaudeSession(input: {
  sessionId: string
  attempt: ClaudeAcquisitionAttempt
  previous: ClaudeAcquisitionAttempt | undefined
  acquisitions: ClaudeAcquisitionRegistry
  sessions: Map<string, ClaudeSession>
  exits: Map<string, ClaudeSessionExit>
  deps: ClaudeStructuredSessionAdapterDeps
  settleExit: ClaudeAcquireCallbacks['settleExit']
}): Promise<ClaudeSession | undefined> {
  const { sessionId, attempt, acquisitions, sessions, exits } = input
  if (input.previous && !(await cancelClaudeAcquisitionAttempt(input.previous))) {
    acquisitions.restoreIfCurrent(sessionId, attempt, input.previous)
    throw new AgentSessionAcquisitionExitUnprovenError(
      new Error(`claude acquisition for session ${sessionId} could not be stopped`)
    )
  }
  acquisitions.assertCurrent(sessionId, attempt)
  let resumeSession = sessions.get(sessionId)
  if (!(await closeClaudePublishedSessionForDeps(sessions, sessionId, input.deps))) {
    throw new AgentSessionAcquisitionExitUnprovenError(
      new Error(`claude session ${sessionId} could not be stopped`)
    )
  }
  // A first-hand exit that has not yet proved its full tree still owns a cleanup
  // obligation; never let a new acquisition hide that evidence by omission.
  const retainedExit = exits.get(sessionId)
  if (retainedExit) {
    const firstProof = retainedExit.closePromise ? await retainedExit.closePromise : false
    const proven = firstProof || (await retainedExit.connection.close().catch(() => false))
    if (!proven) {
      throw claudeAcquisitionCleanupError(retainedExit.connection, retainedExit.error)
    }
    // The old child is superseded by this acquisition. Settle its lifecycle
    // before discarding the retained proof so its cursor and callbacks are
    // cleaned up exactly once.
    await input.settleExit(sessionId, retainedExit)
    resumeSession ??= retainedExit.session
  }
  acquisitions.assertCurrent(sessionId, attempt)
  return resumeSession
}
