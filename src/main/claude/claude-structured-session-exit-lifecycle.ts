import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import { providerExitObserved } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { settledClaudeTurnEndLeaf } from './claude-structured-resume-point'
import { claudeHeldSends } from './claude-command-lifecycle'
import {
  claudeRootExitObserved,
  settleClaudeExitedSession
} from './claude-structured-session-close'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export type ClaudeExitLifecycle = {
  sessions: Map<string, ClaudeSession>
  exits: Map<string, ClaudeSessionExit>
  /** Preserve diagnostics for sends admitted before the host learns of the exit. */
  settledExitErrors: Map<string, Error>
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistHandle' | 'now'>
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
    return
  }
  const observedAt = lifecycle.deps.now?.() ?? Date.now()
  session.events?.observeExit?.(claudeHeldSends(session), observedAt)
  lifecycle.sessions.delete(sessionId)
  // Run tree cleanup before recovery; an exit callback proves only root exit.
  const closePromise = session.connection.close().catch(() => false)
  const exit: ClaudeSessionExit = {
    connection: session.connection,
    session,
    error,
    observedAt,
    closePromise
  }
  lifecycle.exits.set(sessionId, exit)
  exit.publication = closePromise
    .then((proven) => {
      // Observed root exit releases the lease even if tree cleanup remains unverified.
      if (!proven && !claudeRootExitObserved(session.connection)) {
        return undefined
      }
      return settleClaudeUnexpectedExit(lifecycle, sessionId, exit)
    })
    .catch(() => undefined)
}

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
    // Save the completed-turn cursor before recovery permits reacquisition.
    await persistClaudeSessionHandle(sessionId, exit.session, deps).catch((error: unknown) => {
      console.warn('[claude-resume-point] exit cursor was not persisted:', { sessionId, error })
    })
    if (exits.get(sessionId) !== exit) {
      settleClaudeExitedSession(exit.session)
      return
    }
    exits.delete(sessionId)
    lifecycle.settledExitErrors.set(sessionId, exit.error)
    const ended: ClaudeStructuredSessionEvent = {
      type: 'ended',
      sessionId,
      reason: exit.error.message,
      // Distinguish provider exit from a host fault that forced cleanup.
      failure: providerExitObserved(exit.error)
        ? agentSessionFailureFact('providerExited', { detail: providerDiagnosticOf(exit.error) })
        : agentSessionFailureFact('hostFault'),
      cause: 'unexpected-exit',
      fence: exit.session.fence,
      acquisitionGeneration: exit.session.acquisitionGeneration,
      observedAt: exit.observedAt
    }
    try {
      lifecycle.emit(exit.session, ended)
    } finally {
      settleClaudeExitedSession(exit.session)
    }
  })()
  return exit.settlementPromise
}

/** Include exits observed while waiting for earlier publications. */
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
