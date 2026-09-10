import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import type { CodexNamingOrphanRegistry } from './codex-naming-orphan-registry'
import {
  cancelCodexAcquisitionAttempt,
  type CodexAcquisitionRegistry,
  type CodexSession,
  type CodexStructuredSessionAdapterDeps,
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
  onBackgroundTasksChanged?: CodexStructuredSessionAdapterDeps['onBackgroundTasksChanged']
  namingOrphans?: CodexNamingOrphanRegistry
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
  orphanCodexNamingChild(session, input.namingOrphans)
  session.backgroundTasks.clear()
  input.onBackgroundTasksChanged?.(input.sessionId, null)
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
    namingOrphans?: CodexNamingOrphanRegistry
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
  // Naming teardown starts alongside it but is handed off rather than awaited:
  // a best-effort title generator that will not die must not strand the chat.
  orphanCodexNamingChild(session, options?.namingOrphans)
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

/** Detaches the naming child so its exit proof never gates session teardown. */
function orphanCodexNamingChild(
  session: CodexSession,
  namingOrphans: CodexNamingOrphanRegistry | undefined
): void {
  const naming = session.naming
  if (!naming) {
    return
  }
  session.naming = null
  // Started unconditionally: `?.` would short-circuit the argument and leave
  // the child running whenever no registry is wired.
  const closing = naming.close().catch(() => false)
  namingOrphans?.adopt(naming, closing)
}

export async function closeCodexSession(
  sessionId: string,
  sessions: Map<string, CodexSession>,
  acquisitions: CodexAcquisitionRegistry,
  onEvent?: (event: CodexStructuredSessionEvent) => void,
  namingOrphans?: CodexNamingOrphanRegistry
): Promise<boolean> {
  const attempt = acquisitions.get(sessionId)
  if (!(await cancelCodexAcquisitionAttempt(attempt))) {
    return false
  }
  if (attempt) {
    acquisitions.deleteIfCurrent(sessionId, attempt)
  }
  return closeCodexPublishedSession(sessions, sessionId, onEvent, { namingOrphans })
}

/** A child that died unexpectedly: closed only if the session is still the one that owned it. */
export function forceCloseUnexpectedCodexSession(
  sessions: Map<string, CodexSession>,
  sessionId: string,
  fence: number,
  acquisitionGeneration: string,
  reason: Error,
  onEvent?: (event: CodexStructuredSessionEvent) => void
): Promise<boolean> {
  const session = sessions.get(sessionId)
  if (
    !session ||
    session.ended ||
    session.fence !== fence ||
    session.acquisitionGeneration !== acquisitionGeneration
  ) {
    return Promise.resolve(false)
  }
  return closeCodexPublishedSession(sessions, sessionId, onEvent, {
    allowFailedSettlement: true,
    requestedClose: false,
    expectedFence: fence,
    expectedAcquisitionGeneration: acquisitionGeneration,
    unexpectedReason: reason
  })
}

export async function closeAllCodexSessions(
  sessions: Map<string, CodexSession>,
  acquisitions: CodexAcquisitionRegistry,
  close: (sessionId: string) => Promise<boolean>,
  namingOrphans?: CodexNamingOrphanRegistry
): Promise<void> {
  acquisitions.close()
  await closeProcessRegistry({
    attempts: 3,
    hasEntries: () => sessions.size > 0 || acquisitions.size > 0,
    entryIds: () => new Set([...sessions.keys(), ...acquisitions.sessionIds()]),
    closeEntry: close,
    failureMessage: 'codex structured session shutdown could not prove every child stopped'
  })
  // Sessions hand their unproven naming children here on the way out, so this
  // drain runs last — shutdown still proves every child stopped.
  await namingOrphans?.closeAll()
}
