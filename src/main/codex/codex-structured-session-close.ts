import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import {
  cancelCodexAcquisitionAttempt,
  type CodexAcquisitionRegistry,
  type CodexSession,
  type CodexStructuredSessionEvent
} from './codex-structured-session-state'
import type { StructuredAgentSessionEndedEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export function handleCodexSessionExit(input: {
  sessions: Map<string, CodexSession>
  sessionId: string
  connection: CodexAppServerConnection | null
  error: Error
  /** Set for the end of a close Orca began: by that close, or by the root's own exit report. */
  closedByOrca?: true
  /** The close's kill reached the app-server, but its exit was not seen. */
  rootExitUnobserved?: true
  prompts?: CodexSession['prompts']
  onEvent?: (event: CodexStructuredSessionEvent) => void
  logger?: StructuredAgentSessionLogger
}): boolean {
  const session = input.sessions.get(input.sessionId)
  if (!session || session.connection !== input.connection || session.ended) {
    input.prompts?.clear()
    return false
  }
  session.exitObservedAt ??= Date.now()
  // Before the admission check: the child is gone whether or not its end was admitted.
  session.turnOpenWaits.releaseAll()
  const event: StructuredAgentSessionEndedEvent = {
    type: 'ended',
    sessionId: input.sessionId,
    // The connection reports the exit inside the close it ends; the close's own reason is the why.
    reason: ((input.closedByOrca && session.orcaClose?.reason) || input.error).message,
    // Only the child's own exit blames Codex; a close Orca made, for any reason, is Orca's.
    failure: input.closedByOrca
      ? agentSessionFailureFact('hostFault')
      : agentSessionFailureFact('providerExited', { detail: providerDiagnosticOf(input.error) }),
    cause: session.orcaClose?.requested ? 'requested-close' : 'unexpected-exit',
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    observedAt: session.exitObservedAt,
    ...(input.rootExitUnobserved ? { rootExitUnobserved: true as const } : {})
  } as const
  // A synchronous sink rejection (usually backpressure) leaves the terminal rows to the host's
  // exit settlement, which writes its own bounded fallback. The exit itself is observed, so the
  // session ends either way: holding a dead child as unproven over a refused row would strand it.
  const admission = session.translator?.handle(event) ?? { accepted: true }
  if (!admission.accepted) {
    input.logger?.warn("Codex's final rows were refused; the host settles the turn instead", {
      scope: 'codex-exit-rows',
      sessionId: input.sessionId,
      reason: admission.reason
    })
  }
  session.ended = true
  // Nothing can echo for this child any more; the journal's pending-submission
  // recovery is what settles the sends these were armed for.
  session.dispatchEchoes.clear()
  session.backgroundTasks.clear()
  // Every close path funnels here, so the session's children end with it on each one.
  session.backgroundTasks.publishChildWork()
  session.unbindReadingControl?.()
  input.onEvent?.(event)
  session.prompts.clear()
  session.translator?.dispose()
  return true
}

export async function closeCodexPublishedSession(
  sessions: Map<string, CodexSession>,
  sessionId: string,
  onEvent?: (event: CodexStructuredSessionEvent) => void,
  options?: {
    logger?: StructuredAgentSessionLogger
    requestedClose?: boolean
    expectedFence?: number
    expectedAcquisitionGeneration?: string
    unexpectedReason?: Error
  }
): Promise<boolean> {
  const session = sessions.get(sessionId)
  if (!session) {
    return true
  }
  if (
    (options?.expectedFence !== undefined && session.fence !== options.expectedFence) ||
    (options?.expectedAcquisitionGeneration !== undefined &&
      session.acquisitionGeneration !== options.expectedAcquisitionGeneration)
  ) {
    return false
  }
  // Sink-failure recovery force-closes the child but must preserve the
  // observed-exit cause so host lease settlement runs as an unexpected death.
  session.orcaClose = {
    requested: options?.requestedClose ?? true,
    reason: options?.unexpectedReason ?? new Error('codex session closed')
  }
  // Keep the session indexed until the child exit is observed or the kill reached the app-server
  // itself. A failed kill must leave the live connection available for a safe retry.
  const exited = await session.connection.close()
  const killed = exited !== true && session.connection.providerKilled === true
  if (exited !== true && !killed) {
    return false
  }
  if (!session.ended) {
    handleCodexSessionExit({
      sessions,
      sessionId,
      connection: session.connection,
      error: session.orcaClose.reason,
      closedByOrca: true,
      ...(killed ? { rootExitUnobserved: true as const } : {}),
      prompts: session.prompts,
      ...(onEvent ? { onEvent } : {}),
      ...(options?.logger ? { logger: options.logger } : {})
    })
  }
  sessions.delete(sessionId)
  return true
}

export async function closeCodexSession(
  sessionId: string,
  sessions: Map<string, CodexSession>,
  acquisitions: CodexAcquisitionRegistry,
  onEvent?: (event: CodexStructuredSessionEvent) => void,
  logger?: StructuredAgentSessionLogger
): Promise<boolean> {
  const attempt = acquisitions.get(sessionId)
  if (!(await cancelCodexAcquisitionAttempt(attempt))) {
    return false
  }
  if (attempt) {
    acquisitions.deleteIfCurrent(sessionId, attempt)
  }
  return closeCodexPublishedSession(sessions, sessionId, onEvent, logger ? { logger } : {})
}

export async function closeAllCodexSessions(
  sessions: Map<string, CodexSession>,
  acquisitions: CodexAcquisitionRegistry,
  close: (sessionId: string) => Promise<boolean>
): Promise<void> {
  acquisitions.close()
  await closeProcessRegistry({
    attempts: 3,
    hasEntries: () => sessions.size > 0 || acquisitions.size > 0,
    entryIds: () => new Set([...sessions.keys(), ...acquisitions.sessionIds()]),
    closeEntry: close,
    failureMessage: 'codex structured session shutdown could not prove every child stopped'
  })
}
