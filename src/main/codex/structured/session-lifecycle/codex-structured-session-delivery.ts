import type { CodexAcquisitionAttempt, CodexSession } from './codex-structured-session-state'

/** Buffers pre-publication events and drops events from superseded children. */
export function deliverCodexAcquisitionEvent(
  sessions: ReadonlyMap<string, CodexSession>,
  acquisition: CodexAcquisitionAttempt['window'],
  sessionId: string,
  event: () => unknown,
  retainedBytes?: number
): void {
  if (acquisition.buffer(event, retainedBytes)) {
    return
  }
  if (sessions.get(sessionId)?.connection === acquisition.connection) {
    event()
  } else if (acquisition.isOverflowed) {
    // Overflow fails acquisition; close the child so callers can retry.
    void acquisition.connection?.close()
  }
}
