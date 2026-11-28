/** When a person last asked each chat to stop its background work, on this host's clock: an ended
 *  task it stopped is no news to wake its agent for. */
const stopRequestedAt = new Map<string, number>()
const MAX_SESSIONS = 256

export function noteBackgroundStopRequested(sessionId: string, at = Date.now()): void {
  stopRequestedAt.delete(sessionId)
  stopRequestedAt.set(sessionId, at)
  if (stopRequestedAt.size > MAX_SESSIONS) {
    const oldest = stopRequestedAt.keys().next().value
    if (oldest !== undefined) {
      stopRequestedAt.delete(oldest)
    }
  }
}

export function backgroundStopRequestedSince(sessionId: string, since: number): boolean {
  return (stopRequestedAt.get(sessionId) ?? -Infinity) >= since
}
