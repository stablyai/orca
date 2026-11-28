// Forwards one running session made for itself (one Mobile Emulator attach): each has that session as
// its only owner, is listed while open, is never saved or shared, and closes when the session ends.
const ownerByForwardId = new Map<string, { session: string; environmentId: string }>()
// An ensure still queued when its session ends must not open a forward afterwards.
const endedSessions = new Set<string>()
// Only an ensure in flight can name an ended session, so the most recent ones suffice.
const MAX_ENDED_SESSIONS = 256

/** Closing a session's forward: `when` decides in the server's queue; the server is remembered, since
 *  an edit underway can hide the forward from the server's list. */
export type SessionForwardRemoval = { environmentId: string; when: () => boolean }

/** The session that owns the forward; undefined for a person's forward. */
export function pairedPortForwardSession(id: string): string | undefined {
  return ownerByForwardId.get(id)?.session
}

/** The forward of `remotePort` that `session` owns, or a person's when `session` is undefined. */
export function forwardsPortFor(
  entry: { id: string; remotePort: number },
  remotePort: number,
  session: string | undefined
): boolean {
  return entry.remotePort === remotePort && ownerByForwardId.get(entry.id)?.session === session
}

/** Gives a new forward to `session`; false when the session already ended, so the caller closes it. */
export function ownPairedPortForward(id: string, session: string, environmentId: string): boolean {
  if (endedSessions.has(session)) {
    return false
  }
  ownerByForwardId.set(id, { session, environmentId })
  return true
}

/** The forward is a person's now, or gone. */
export function dropPairedPortForwardSession(id: string): void {
  ownerByForwardId.delete(id)
}

/** Ends `session`: it opens nothing more, and returns the forwards it owns, with their servers (an edit
 *  underway can hide one from the server's list), for the caller to close. */
export function endPairedPortForwardSession(
  session: string
): { id: string; environmentId: string }[] {
  endedSessions.add(session)
  if (endedSessions.size > MAX_ENDED_SESSIONS) {
    endedSessions.delete(endedSessions.values().next().value!)
  }
  return [...ownerByForwardId]
    .filter(([, owner]) => owner.session === session)
    .map(([id, owner]) => ({ id, environmentId: owner.environmentId }))
}
