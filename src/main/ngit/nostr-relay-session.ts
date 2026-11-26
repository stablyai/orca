import WebSocket from 'ws'
import { z } from 'zod'
import { verifyEvent } from 'nostr-tools/pure'
import { matchFilter, type Filter } from 'nostr-tools/filter'
import { mapWithConcurrency } from '../../shared/concurrency/map-with-concurrency'
import type { NostrEvent } from './nostr-event-tags'

const SignedEvent = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number().int(),
  kind: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string()
})

const CONNECT_TIMEOUT_MS = 6_000
// Public relays can take several seconds per query on a large repository.
const REQUEST_TIMEOUT_MS = 20_000
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024
const PAGE_LIMIT = 500
const MAX_PAGES = 6
// Relays cap open subscriptions per connection, some far below a large repository's filter count.
const MAX_OPEN_REQUESTS = 4

/** Relay URLs come from events anyone can publish, so only websocket URLs are ever dialled. */
export function normalizeRelayUrl(raw: string): string | null {
  try {
    const url = new URL(raw.includes('://') ? raw : `wss://${raw}`)
    if ((url.protocol !== 'wss:' && url.protocol !== 'ws:') || url.username || url.password) {
      return null
    }
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

export class NostrRelaysUnreachableError extends Error {
  constructor(relays: readonly string[]) {
    super(`No Nostr relay answered (${relays.join(', ') || 'none configured'}).`)
    this.name = 'NostrRelaysUnreachableError'
  }
}

type RelayConnection = {
  request(filter: Filter): Promise<NostrEvent[]>
  close(): void
}

function connectRelay(url: string): Promise<RelayConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: MAX_MESSAGE_BYTES
    })
    const pending = new Map<string, (message: unknown[] | null) => void>()
    let requestCount = 0
    const failPending = (): void => {
      for (const listener of pending.values()) {
        listener(null)
      }
    }
    socket.on('error', (error) => {
      reject(error)
      failPending()
    })
    socket.on('close', () => {
      reject(new Error(`Relay closed: ${url}`))
      failPending()
    })
    socket.on('message', (data) => {
      let message: unknown
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (Array.isArray(message) && typeof message[1] === 'string') {
        pending.get(message[1])?.(message)
      }
    })
    socket.once('open', () => {
      resolve({
        request(filter) {
          return new Promise((done, fail) => {
            const subscription = `orca-${++requestCount}`
            const events: NostrEvent[] = []
            const settle = (error?: Error): void => {
              clearTimeout(timer)
              pending.delete(subscription)
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(['CLOSE', subscription]))
              }
              if (error) {
                fail(error)
              } else {
                done(events)
              }
            }
            const timer = setTimeout(
              () => settle(new Error(`Relay timed out: ${url}`)),
              REQUEST_TIMEOUT_MS
            )
            pending.set(subscription, (message) => {
              if (!message || message[0] === 'CLOSED') {
                settle(new Error(`Relay refused or dropped the request: ${url}`))
              } else if (message[0] === 'EOSE') {
                settle()
              } else if (message[0] === 'EVENT') {
                const event = SignedEvent.safeParse(message[2])
                if (event.success) {
                  events.push(event.data)
                }
              }
            })
            socket.send(JSON.stringify(['REQ', subscription, filter]))
          })
        },
        close: () => socket.close()
      })
    })
  })
}

/** A relay is untrusted: keep only well-signed events that answer the question asked. */
function isTrustworthy(event: NostrEvent, filter: Filter): boolean {
  try {
    return matchFilter(filter, event) && verifyEvent(event)
  } catch {
    return false
  }
}

async function requestAllPages(connection: RelayConnection, filter: Filter): Promise<NostrEvent[]> {
  const events: NostrEvent[] = []
  let until = filter.until
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageFilter = { ...filter, limit: PAGE_LIMIT, ...(until ? { until } : {}) }
    const received = await connection.request(pageFilter)
    events.push(...received.filter((event) => isTrustworthy(event, pageFilter)))
    if (received.length < PAGE_LIMIT) {
      break
    }
    until = Math.min(...received.map((event) => event.created_at)) - 1
  }
  return events
}

export type NostrQuery = (relays: readonly string[], filters: Filter[]) => Promise<NostrEvent[]>

export type NostrRelaySession = { query: NostrQuery; close(): void }

/** One connection per relay for the life of the session. Throws when no relay answers. */
export function openNostrRelaySession(): NostrRelaySession {
  const connections = new Map<string, Promise<RelayConnection>>()
  const connectionTo = (url: string): Promise<RelayConnection> => {
    let connection = connections.get(url)
    if (!connection) {
      connection = connectRelay(url)
      connections.set(url, connection)
    }
    return connection
  }
  return {
    async query(relays, filters) {
      const urls = [...new Set(relays.map(normalizeRelayUrl).filter((url) => url !== null))]
      const results = await Promise.allSettled(
        urls.map(async (url) => {
          const connection = await connectionTo(url)
          return (
            await mapWithConcurrency(filters, MAX_OPEN_REQUESTS, (filter) =>
              requestAllPages(connection, filter)
            )
          ).flat()
        })
      )
      const answered = results.filter((result) => result.status === 'fulfilled')
      if (answered.length === 0) {
        throw new NostrRelaysUnreachableError(urls)
      }
      const byId = new Map(
        answered.flatMap((result) => result.value.map((event) => [event.id, event] as const))
      )
      return [...byId.values()]
    },
    close() {
      for (const connection of connections.values()) {
        void connection.then((open) => open.close()).catch(() => {})
      }
      connections.clear()
    }
  }
}
