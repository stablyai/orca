// Remote desktop sessions this computer opened: which localhost forward port carries which cloud
// workspace's desktop, and how to mint that desktop a connection ticket. A browser page is a
// remote desktop only when its URL names one of these ports (main decides, never the page), and
// only such a page is handed tickets, keyboard capture and the clipboard bridge. The URL must be
// exactly the one Orca built (no host/port/encrypt overrides for noVNC), and the session ends with
// its forward: a later forward or local server on the same port is never trusted.
import { cloudRemoteDesktopUrl } from '../../shared/hosted-sandbox/cloud-remote-desktop'

export type RemoteDesktopMintFailure =
  | 'asleep'
  | 'archived'
  | 'starting'
  | 'signed_out'
  | 'unavailable'

export type RemoteDesktopMintResult =
  | { ok: true; ticket: string; expiresAt: number }
  | { ok: false; reason: RemoteDesktopMintFailure }

export type RemoteDesktopSession = {
  environmentId: string
  localPort: number
  /** noVNC's page on the VM ("vnc.html"). */
  path: string
  /** Asks the sandbox for a fresh single-use ticket (starts the desktop if it stopped). */
  mint: () => Promise<RemoteDesktopMintResult>
  /** False once the forward this session opened is gone (closed, slept, re-dialed elsewhere). */
  isLive?: () => boolean
}

type Entry = RemoteDesktopSession & {
  /** The ticket minted with the open itself, saved for the page load that follows. */
  pending: { ticket: string; expiresAt: number } | null
  listeners: Set<() => void>
}

/** A ticket this close to expiry is not handed out: the page still has to dial the forward. */
const TICKET_MARGIN_MS = 5_000

const sessionsByPort = new Map<number, Entry>()

/** Records (or refreshes) a session and wakes any open page for it that stopped retrying. */
export function registerRemoteDesktopSession(
  session: RemoteDesktopSession,
  firstTicket: { ticket: string; expiresAt: number } | null
): void {
  const previous = sessionsByPort.get(session.localPort)
  const entry: Entry = {
    ...session,
    pending: firstTicket,
    listeners: previous?.listeners ?? new Set()
  }
  sessionsByPort.set(session.localPort, entry)
  for (const listener of entry.listeners) {
    listener()
  }
}

/** The session behind a desktop page URL, or null for any other page. */
export function remoteDesktopSessionForUrl(url: string): RemoteDesktopSession | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return null
  }
  const port = Number(parsed.port)
  const entry = sessionsByPort.get(port)
  if (!entry) {
    return null
  }
  if (entry.isLive && !entry.isLive()) {
    sessionsByPort.delete(port)
    return null
  }
  // Exactly Orca's URL: noVNC reads host, port, encrypt and logging from the query and the hash,
  // which would let a page point a ticketed session (and the user's keys) somewhere else.
  const expected = new URL(cloudRemoteDesktopUrl(port, entry.path))
  return parsed.protocol === 'http:' &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === expected.pathname &&
    parsed.search === expected.search &&
    parsed.hash === ''
    ? entry
    : null
}

/** A ticket for the next WebSocket: the one minted with the open if still fresh, else a new one. */
export async function takeRemoteDesktopTicket(
  session: RemoteDesktopSession,
  now: () => number = Date.now
): Promise<RemoteDesktopMintResult> {
  const entry = sessionsByPort.get(session.localPort)
  const pending = entry?.pending
  if (entry && pending) {
    entry.pending = null
    if (pending.expiresAt - TICKET_MARGIN_MS > now()) {
      return { ok: true, ...pending }
    }
  }
  return (entry ?? session).mint()
}

/** Called when the session for this port is opened again (the user chose Open remote desktop). */
export function onRemoteDesktopSessionRefreshed(
  localPort: number,
  listener: () => void
): () => void {
  let entry = sessionsByPort.get(localPort)
  if (!entry) {
    return () => {}
  }
  entry.listeners.add(listener)
  return () => {
    entry?.listeners.delete(listener)
    entry = undefined
  }
}

export function resetRemoteDesktopSessionsForTest(): void {
  sessionsByPort.clear()
}
