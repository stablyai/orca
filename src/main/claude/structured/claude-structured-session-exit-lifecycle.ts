import type { ClaudeStreamJsonConnection } from '../claude-stream-json-connection'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import {
  agentSessionFailureFact,
  providerDiagnosticOf
} from '../../../shared/agent-session/failures/agent-session-failure'
import {
  providerExitObserved,
  providerStartupFailureFact,
  startupAcquisitionRefusal
} from '../../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import { providerSpawnAbsent } from '../../provider-process/provider-executable-missing'
import {
  claudeSessionHasTurnWork,
  settledClaudeTurnEndLeaf
} from './claude-structured-resume-point'
import { claudeHeldSends } from '../claude-command-lifecycle'
import { ClaudePluginInputError } from '../claude-plugin-ui'
import type { AgentSessionStartEndings } from '../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import { claudeExitEnding } from './claude-structured-start-ending'
import {
  closeClaudePublishedSessionForDeps,
  claudeCloseReport,
  settleClaudeExitedSession
} from './claude-structured-session-close'
import { retireClaudeDispatchWaiters } from './claude-structured-dispatch'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'
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
  /** Taken when the exit is first seen, so a start settling meanwhile cannot miss it. */
  endings: AgentSessionStartEndings
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
  lifecycle.endings.record(sessionId, session.acquisitionGeneration, claudeExitEnding(error))
  lifecycle.sessions.delete(sessionId)
  // Register cleanup ownership before semantic publication can wake another provider write.
  const cleanup = Promise.resolve()
    .then(() => session.connection.close())
    .catch(() => false)
  const closePromise =
    claudeStartDied(session) && providerExitObserved(error)
      ? withTimeout(cleanup, 2_000, false)
      : cleanup
  const exit: ClaudeSessionExit = {
    connection: session.connection,
    session,
    error,
    observedAt,
    closePromise
  }
  lifecycle.exits.set(sessionId, exit)
  try {
    if (error instanceof ClaudePluginInputError) {
      const waiter = session.dispatchWaiters.find((entry) => entry.clientMessageId !== null)
      // Delivery remains uncertain, but this connection no longer owes a running action.
      retireClaudeDispatchWaiters(session)
      lifecycle.emit(session, {
        type: 'retiring',
        sessionId,
        providerSessionId: session.providerSessionId,
        reason: error.message,
        failure: error.failure,
        fence: session.fence,
        acquisitionGeneration: session.acquisitionGeneration,
        observedAt,
        ...(waiter?.clientMessageId
          ? {
              unopenedSend: {
                clientMessageId: waiter.clientMessageId,
                ...(waiter.requestedAt === null ? {} : { requestedAt: waiter.requestedAt })
              }
            }
          : {})
      })
    }
  } finally {
    exit.publication = closePromise
      .then((proven) => {
        // Observed root exit releases the lease even if tree cleanup remains unverified.
        if (
          claudeCloseReport(session.connection, proven, error) instanceof
          AgentSessionAcquisitionExitUnprovenError
        ) {
          return undefined
        }
        return settleClaudeUnexpectedExit(lifecycle, sessionId, exit)
      })
      .catch(() => undefined)
  }
}

/** Exited before the host-awaited open returned and before any turn; turns can settle without an Orca dispatch. */
function claudeStartDied(session: ClaudeSession): boolean {
  // Initialize can answer while a resume open still waits on transcript catch-up.
  return !session.initialization.startup.opened() && !claudeSessionHasTurnWork(session)
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
    // A dead start's host open is still waiting on this exit, and nothing advanced acquisition's cursor.
    if (!claudeStartDied(exit.session)) {
      await persistClaudeSessionHandle(sessionId, exit.session, deps).catch((error: unknown) => {
        console.warn('[claude-resume-point] exit cursor was not persisted:', { sessionId, error })
      })
    }
    if (exits.get(sessionId) !== exit) {
      settleClaudeExitedSession(exit.session)
      return
    }
    exits.delete(sessionId)
    const report = claudeCloseReport(exit.connection, true, exit.error)
    lifecycle.settledExitErrors.set(sessionId, report ?? exit.error)
    const startupFailure = claudeSessionHasTurnWork(exit.session)
      ? undefined
      : exit.connection.startupFailure?.()
    const ended: ClaudeStructuredSessionEvent = {
      type: 'ended',
      sessionId,
      reason: exit.error.message,
      // A typed startup refusal or a spawn ENOENT keeps its next step; else provider exit vs host fault.
      failure:
        exit.error instanceof ClaudePluginInputError
          ? exit.error.failure
          : startupAcquisitionRefusal(exit.error) || providerSpawnAbsent(exit.error)
            ? providerStartupFailureFact(exit.error)
            : startupFailure
              ? providerStartupFailureFact(startupFailure)
              : providerExitObserved(exit.error)
                ? agentSessionFailureFact('providerExited', {
                    detail: providerDiagnosticOf(exit.error)
                  })
                : agentSessionFailureFact('hostFault'),
      cause: 'unexpected-exit',
      ...(report instanceof AgentSessionAcquisitionRootExitObservedError &&
      report.deathEvidenceKind === 'kill-delivered'
        ? { deathEvidenceKind: 'kill-delivered' as const }
        : {}),
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

/** Complete the pending close for this exact connection after observing its root exit. */
export function finishClaudeCloseAfterExit(input: {
  sessions: Map<string, ClaudeSession>
  exits: Map<string, ClaudeSessionExit>
  closeExit: (sessionId: string) => Promise<boolean>
  sessionId: string
  connection: ClaudeStreamJsonConnection | null
  deps: Parameters<typeof closeClaudePublishedSessionForDeps>[2]
  afterClose: (close: () => Promise<boolean>) => Promise<boolean>
}): void {
  const { sessions, sessionId, deps } = input
  const exit = input.exits.get(sessionId)
  if (
    sessions.get(sessionId)?.connection !== input.connection &&
    exit?.connection !== input.connection
  ) {
    return
  }
  void input
    .afterClose(() =>
      exit
        ? input.closeExit(sessionId)
        : closeClaudePublishedSessionForDeps(sessions, sessionId, deps)
    )
    .catch((error: unknown) =>
      deps.logger?.warn('finishing a Claude close after its process exited reported', {
        scope: 'claude-close-after-exit',
        sessionId,
        error
      })
    )
}
