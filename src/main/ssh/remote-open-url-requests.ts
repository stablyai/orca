import { randomUUID } from 'node:crypto'

/** Where a sign-in page will send the browser back to: a listener on the remote host's loopback. */
export type LoopbackCallback = { host: '127.0.0.1' | 'localhost'; port: number; path: string }

export type RemoteOpenUrlTicket = {
  url: string
  sshTargetId: string
  callback: LoopbackCallback | null
  expiresAt: number
}

const TICKET_TTL_MS = 120_000
// Why a cap: tickets are minted by remote hosts (already rate-limited); this bounds memory regardless.
const MAX_TICKETS = 64
const tickets = new Map<string, RemoteOpenUrlTicket>()

/**
 * Finds the loopback `redirect_uri` of an OAuth authorize URL. Only plain http on the loopback
 * name/address a CLI listens on, with an explicit unprivileged port and a real callback path;
 * anything else gets no forward and the sign-in behaves exactly as before.
 */
export function parseLoopbackCallback(rawUrl: string): LoopbackCallback | null {
  let redirect: URL
  try {
    const raw = new URL(rawUrl).searchParams.get('redirect_uri')
    if (!raw) {
      return null
    }
    redirect = new URL(raw)
  } catch {
    return null
  }
  if (redirect.protocol !== 'http:' || redirect.username || redirect.password) {
    return null
  }
  // Why these two only: `::1` and other loopback aliases are never used by the CLIs this serves,
  // and the desktop listener binds 127.0.0.1, which browsers reach for `localhost` too.
  const host = redirect.hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    return null
  }
  const port = Number(redirect.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return null
  }
  if (redirect.pathname === '/' || redirect.pathname.length === 0) {
    return null
  }
  return { host, port, path: redirect.pathname }
}

/** Records an open request; the renderer can only act on it by presenting this single-use id. */
export function issueRemoteOpenUrlTicket(
  params: { url: string; sshTargetId: string },
  now: number = Date.now()
): { requestId: string; ticket: RemoteOpenUrlTicket } {
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAt <= now) {
      tickets.delete(id)
    }
  }
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next().value
    if (oldest === undefined) {
      break
    }
    tickets.delete(oldest)
  }
  const ticket: RemoteOpenUrlTicket = {
    url: params.url,
    sshTargetId: params.sshTargetId,
    callback: parseLoopbackCallback(params.url),
    expiresAt: now + TICKET_TTL_MS
  }
  const requestId = randomUUID()
  tickets.set(requestId, ticket)
  return { requestId, ticket }
}

/** Removes the ticket before returning it, so a replayed or forged approval finds nothing. */
export function consumeRemoteOpenUrlTicket(
  requestId: unknown,
  now: number = Date.now()
): RemoteOpenUrlTicket | null {
  if (typeof requestId !== 'string') {
    return null
  }
  const ticket = tickets.get(requestId)
  tickets.delete(requestId)
  if (!ticket || ticket.expiresAt <= now) {
    return null
  }
  return ticket
}

export function clearRemoteOpenUrlTicketsForTests(): void {
  tickets.clear()
}
