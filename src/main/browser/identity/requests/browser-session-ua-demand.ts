import type { Session } from 'electron'

// Whether a guest's requests need a header rewrite, from its page and from site iframes in it
// (keyed by frame tree node, which survives the frame's own navigations).
type GuestDemand = { session: Session; page: boolean; frames: Set<number> }
const guests = new Map<number, GuestDemand>()
const demandingGuestsBySession = new Map<Session, number>()
const watchers = new Map<Session, Set<() => void>>()

function notify(session: Session): void {
  for (const watcher of watchers.get(session) ?? []) {
    watcher()
  }
}

function count(session: Session, delta: 1 | -1): void {
  const next = (demandingGuestsBySession.get(session) ?? 0) + delta
  if (next > 0) {
    demandingGuestsBySession.set(session, next)
  } else {
    demandingGuestsBySession.delete(session)
  }
  if (next === 0 || (delta === 1 && next === 1)) {
    notify(session)
  }
}

function write(guestId: number, next: GuestDemand | null): void {
  const previous = guests.get(guestId)
  const was = previous && (previous.page || previous.frames.size > 0) ? previous.session : null
  const now = next && (next.page || next.frames.size > 0) ? next.session : null
  if (next) {
    guests.set(guestId, next)
  } else {
    guests.delete(guestId)
  }
  if (was !== now) {
    if (was) {
      count(was, -1)
    }
    if (now) {
      count(now, 1)
    }
  }
}

/** The guest's page demand; `frames` false also drops iframe demand (a new document committed). */
export function setBrowserGuestPageUserAgentDemand(
  session: Session,
  guestId: number,
  page: boolean,
  frames: 'keep' | 'clear' = 'keep'
): void {
  const previous = guests.get(guestId)
  const kept =
    frames === 'keep' && previous?.session === session ? previous.frames : new Set<number>()
  write(guestId, { session, page, frames: kept })
}

/** Whether one site iframe in the guest (e.g. Teams inside another page) needs header rewrites. */
export function setBrowserGuestFrameUserAgentDemand(
  session: Session,
  guestId: number,
  frameTreeNodeId: number,
  demanding: boolean
): void {
  const previous = guests.get(guestId)
  if (previous?.session !== session) {
    if (demanding) {
      write(guestId, { session, page: false, frames: new Set([frameTreeNodeId]) })
    }
    return
  }
  // In place: a page with many site iframes changes one entry, not a copy of the set.
  const before = previous.page || previous.frames.size > 0
  if (demanding) {
    previous.frames.add(frameTreeNodeId)
  } else {
    previous.frames.delete(frameTreeNodeId)
  }
  const after = previous.page || previous.frames.size > 0
  if (before !== after) {
    count(session, after ? 1 : -1)
  }
}

export function getBrowserGuestFrameUserAgentDemand(guestId: number): ReadonlySet<number> {
  return guests.get(guestId)?.frames ?? new Set<number>()
}

export function clearBrowserGuestUserAgentDemand(guestId: number): void {
  write(guestId, null)
}

export function hasBrowserSessionUserAgentDemand(session: Session): boolean {
  return demandingGuestsBySession.has(session)
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
