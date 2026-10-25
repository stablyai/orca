import { settleCodexRequestEndWaiters } from './codex-request-end-wait'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import { closeProcessRegistry } from '@orca/process-host/close-process-registry'
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
  /** Includes root exits reported during or after an Orca close attempt. */
  closedByOrca?: true
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
  session.events?.observeExit?.(session.dispatchEchoes.heldSends(), session.exitObservedAt)
  // Release waits even if terminal journal rows are refused.
  session.turnOpenWaits.releaseAll()
  const event: StructuredAgentSessionEndedEvent = {
    type: 'ended',
    sessionId: input.sessionId,
    // Preserve the initiating close reason when its exit arrives.
    reason: ((input.closedByOrca && session.orcaClose?.reason) || input.error).message,
    // Orca-initiated closes are host faults, regardless of the exit report.
    failure: input.closedByOrca
      ? agentSessionFailureFact('hostFault')
      : agentSessionFailureFact('providerExited', { detail: providerDiagnosticOf(input.error) }),
    cause: session.orcaClose?.requested ? 'requested-close' : 'unexpected-exit',
    ...(input.closedByOrca && input.connection?.closeResult
      ? {
          processExit: {
            root: input.connection.closeResult.root,
            workload: input.connection.closeResult.tree ?? 'unverifiable'
          }
        }
      : {}),
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    observedAt: session.exitObservedAt
  } as const
  // Refused terminal rows use host settlement fallback; the observed child exit remains proven.
  const admission = session.translator?.handle(event) ?? { accepted: true }
  if (!admission.accepted) {
    input.logger?.warn("Codex's final rows were refused; the host settles the turn instead", {
      scope: 'codex-exit-rows',
      sessionId: input.sessionId,
      reason: admission.reason
    })
  }
  session.ended = true
  settleCodexRequestEndWaiters(session)
  // Journal recovery settles sends that can no longer receive a provider echo.
  session.dispatchEchoes.clear()
  session.backgroundTasks.clear(event.processExit)
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
  if (session.ended && session.connection.closed) {
    sessions.delete(sessionId)
    return true
  }
  // Preserve unexpected-death settlement when sink failure forces a close.
  session.orcaClose ??= {
    requested: options?.requestedClose ?? true,
    reason: options?.unexpectedReason ?? new Error('codex session closed')
  }
  // Keep unproven closes indexed for a safe retry.
  const exited = await session.connection.close()
  if (exited !== true) {
    return false
  }
  if (!session.ended) {
    handleCodexSessionExit({
      sessions,
      sessionId,
      connection: session.connection,
      error: session.orcaClose.reason,
      closedByOrca: true,
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
  logger?: StructuredAgentSessionLogger,
  requestedClose = true
): Promise<boolean> {
  const attempt = acquisitions.get(sessionId)
  const published = sessions.get(sessionId)
  if (attempt && published?.connection === attempt.window.connection) {
    attempt.cancelled = true
    attempt.requestedClose = requestedClose
    const closed = await closeCodexPublishedSession(sessions, sessionId, onEvent, {
      requestedClose,
      ...(logger ? { logger } : {})
    })
    if (closed) {
      acquisitions.deleteIfCurrent(sessionId, attempt)
    }
    return closed
  }
  if (!(await cancelCodexAcquisitionAttempt(attempt, requestedClose))) {
    return false
  }
  if (attempt) {
    acquisitions.deleteIfCurrent(sessionId, attempt)
  }
  return closeCodexPublishedSession(sessions, sessionId, onEvent, {
    requestedClose,
    ...(logger ? { logger } : {})
  })
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
