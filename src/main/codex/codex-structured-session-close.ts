import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import {
  cancelCodexAcquisitionAttempt,
  type CodexAcquisitionRegistry,
  type CodexSession,
  type CodexStructuredSessionEvent
} from './codex-structured-session-state'
import type {
  StructuredAgentSessionEndedEvent,
  StructuredAgentSessionStopCause
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export function handleCodexSessionExit(input: {
  sessions: Map<string, CodexSession>
  sessionId: string
  connection: CodexAppServerConnection | null
  error: Error
  /** Set by Orca's own close. Absent only from the connection's onExit, which the connection
   *  withholds while Orca is closing the child. */
  closedByOrca?: true
  prompts?: CodexSession['prompts']
  allowFailedSettlement?: boolean
  onEvent?: (event: CodexStructuredSessionEvent) => void
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
    reason: input.error.message,
    // Only the child's own exit blames Codex; a close Orca made, for any reason, is Orca's.
    failure: input.closedByOrca
      ? agentSessionFailureFact('hostFault')
      : agentSessionFailureFact('providerExited', { detail: providerDiagnosticOf(input.error) }),
    cause: session.requestedClose ? 'requested-close' : 'unexpected-exit',
    ...(session.requestedClose && session.closeStopCause
      ? { stopCause: session.closeStopCause }
      : {}),
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    observedAt: session.exitObservedAt
  } as const
  // A synchronous sink rejection (usually backpressure) leaves the terminal rows to the host's
  // exit settlement, which writes its own bounded fallback.
  const admission = session.translator?.handle(event) ?? { accepted: true }
  // The connection invokes onExit exactly once, so an unexpected exit is forwarded even when
  // admission is backpressured; waiting for a second callback would strand the lease.
  if (!admission.accepted && event.cause !== 'unexpected-exit' && !input.allowFailedSettlement) {
    return false
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
    allowFailedSettlement?: boolean
    requestedClose?: boolean
    /** Who asked for a requested close; the translator settles the open turn with it. */
    stopCause?: StructuredAgentSessionStopCause
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
  session.requestedClose = options?.requestedClose ?? true
  session.closeStopCause = options?.stopCause
  // Keep the session indexed until the child exit is observed. A timeout or
  // failed kill must leave the live connection available for a safe retry.
  const exited = await session.connection.close()
  if (exited !== true) {
    return false
  }
  if (!session.ended) {
    const handled = handleCodexSessionExit({
      sessions,
      sessionId,
      connection: session.connection,
      error: options?.unexpectedReason ?? new Error('codex session closed'),
      closedByOrca: true,
      prompts: session.prompts,
      ...(options?.allowFailedSettlement ? { allowFailedSettlement: true } : {}),
      ...(onEvent ? { onEvent } : {})
    })
    // Keep the closed session indexed when terminal settlement admission was
    // rejected; a later close attempt retries the same stable lifecycle event.
    if (!handled) {
      return false
    }
  }
  sessions.delete(sessionId)
  return true
}

export async function closeCodexSession(
  sessionId: string,
  sessions: Map<string, CodexSession>,
  acquisitions: CodexAcquisitionRegistry,
  onEvent?: (event: CodexStructuredSessionEvent) => void,
  stopCause?: StructuredAgentSessionStopCause
): Promise<boolean> {
  const attempt = acquisitions.get(sessionId)
  if (!(await cancelCodexAcquisitionAttempt(attempt))) {
    return false
  }
  if (attempt) {
    acquisitions.deleteIfCurrent(sessionId, attempt)
  }
  return closeCodexPublishedSession(sessions, sessionId, onEvent, stopCause ? { stopCause } : {})
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
