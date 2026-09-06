import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import {
  cancelCodexAcquisitionAttempt,
  type CodexAcquisitionRegistry,
  type CodexSession,
  type CodexStructuredSessionEvent
} from './codex-structured-session-state'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export function handleCodexSessionExit(input: {
  sessions: Map<string, CodexSession>
  sessionId: string
  connection: CodexAppServerConnection | null
  error: Error
  prompts?: CodexSession['prompts']
  allowFailedSettlement?: boolean
  onEvent?: (event: CodexStructuredSessionEvent) => void
}): boolean {
  const session = input.sessions.get(input.sessionId)
  if (!session || session.connection !== input.connection || session.ended) {
    input.prompts?.clear()
    return false
  }
  const event: StructuredAgentSessionLifecycleEvent = {
    type: 'ended',
    sessionId: input.sessionId,
    reason: input.error.message,
    cause: session.requestedClose ? 'requested-close' : 'unexpected-exit',
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration
  } as const
  // A synchronous sink rejection (usually backpressure) is handed to host
  // recovery, which appends the bounded fallback before reacquisition.
  const admission = session.translator?.handle(event) ?? { accepted: true }
  if (!admission.accepted) {
    // The connection invokes onExit exactly once. Forward a flagged event so
    // host recovery can append its no-new-blob fallback even when admission is
    // backpressured; waiting for a second callback would strand the lease.
    if (event.cause !== 'unexpected-exit' && !input.allowFailedSettlement) {
      return false
    }
    event.settlementRetryRequired = true
  }
  session.ended = true
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
  onEvent?: (event: CodexStructuredSessionEvent) => void
): Promise<boolean> {
  const attempt = acquisitions.get(sessionId)
  if (!(await cancelCodexAcquisitionAttempt(attempt))) {
    return false
  }
  if (attempt) {
    acquisitions.deleteIfCurrent(sessionId, attempt)
  }
  return closeCodexPublishedSession(sessions, sessionId, onEvent)
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
