import type { Session } from 'electron'

// Guests whose current identity changes request headers, and the session each one loads in.
const demandingGuests = new Map<number, Session>()
const watchers = new Map<Session, Set<() => void>>()

function notify(session: Session): void {
  for (const watcher of watchers.get(session) ?? []) {
    watcher()
  }
}

/** Set at each identity change; true while the guest's requests need a header rewrite. */
export function setBrowserGuestUserAgentDemand(
  session: Session,
  guestId: number,
  needed: boolean
): void {
  const previous = demandingGuests.get(guestId)
  if (needed) {
    demandingGuests.set(guestId, session)
  } else {
    demandingGuests.delete(guestId)
  }
  if (previous && previous !== session) {
    notify(previous)
  }
  if (previous !== (needed ? session : undefined)) {
    notify(session)
  }
}

export function clearBrowserGuestUserAgentDemand(guestId: number): void {
  const previous = demandingGuests.get(guestId)
  if (previous) {
    demandingGuests.delete(guestId)
    notify(previous)
  }
}

export function hasBrowserSessionUserAgentDemand(session: Session): boolean {
  for (const demanding of demandingGuests.values()) {
    if (demanding === session) {
      return true
    }
  }
  return false
}

export function watchBrowserSessionUserAgentDemand(
  session: Session,
  onChange: () => void
): () => void {
  let set = watchers.get(session)
  if (!set) {
    set = new Set()
    watchers.set(session, set)
  }
  set.add(onChange)
  return () => {
    const current = watchers.get(session)
    current?.delete(onChange)
    if (current?.size === 0) {
      watchers.delete(session)
    }
  }
}
