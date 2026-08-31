import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import {
  cancelCodexAcquisitionAttempt,
  type CodexAcquisitionRegistry,
  type CodexSession,
  type CodexStructuredSessionEvent
} from './codex-structured-session-state'

export function handleCodexSessionExit(input: {
  sessions: Map<string, CodexSession>
  sessionId: string
  connection: CodexAppServerConnection | null
  error: Error
  onEvent?: (event: CodexStructuredSessionEvent) => void
}): void {
  const session = input.sessions.get(input.sessionId)
  if (!session || session.connection !== input.connection || session.ended) {
    return
  }
  session.ended = true
  const event = { type: 'ended', sessionId: input.sessionId, reason: input.error.message } as const
  session.translator?.handle(event)
  input.onEvent?.(event)
  session.translator?.dispose()
}

export async function closeCodexPublishedSession(
  sessions: Map<string, CodexSession>,
  sessionId: string,
  onEvent?: (event: CodexStructuredSessionEvent) => void
): Promise<boolean> {
  const session = sessions.get(sessionId)
  if (!session) {
    return true
  }
  session.prompts.clear()
  // Keep the session indexed until the child exit is observed. A timeout or
  // failed kill must leave the live connection available for a safe retry.
  const exited = await session.connection.close()
  if (exited !== true) {
    return false
  }
  sessions.delete(sessionId)
  if (!session.ended) {
    session.ended = true
    const event: CodexStructuredSessionEvent = {
      type: 'ended',
      sessionId,
      reason: 'codex session closed'
    }
    session.translator?.handle(event)
    onEvent?.(event)
    session.translator?.flush()
    session.translator?.dispose()
  }
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
