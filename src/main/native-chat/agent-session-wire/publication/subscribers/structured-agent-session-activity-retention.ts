export const MAX_RETAINED_SESSIONS = 512

/** Keeps each session's latest ephemeral value, dropping the least recently set past the cap. */
export function rememberLatestPerSession<T>(
  bySession: Map<string, T>,
  sessionId: string,
  value: T | null | undefined
): void {
  // Absent leaves the session's value alone; null forgets it.
  if (value === undefined) {
    return
  }
  bySession.delete(sessionId)
  if (value === null) {
    return
  }
  bySession.set(sessionId, value)
  while (bySession.size > MAX_RETAINED_SESSIONS) {
    const oldest = bySession.keys().next()
    if (oldest.done || oldest.value === sessionId) {
      break
    }
    bySession.delete(oldest.value)
  }
}
