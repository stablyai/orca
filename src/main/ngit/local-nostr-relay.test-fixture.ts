import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { matchFilter, type Filter } from 'nostr-tools/filter'
import type { NostrEvent } from './nostr-event-tags'

/** A throwaway key per label; nothing signed with it ever leaves the test process. */
export function testAuthor(seed: number) {
  const secret = new Uint8Array(32).fill(seed)
  return {
    pubkey: getPublicKey(secret),
    sign(kind: number, tags: string[][], content = '', createdAt = 1_000): NostrEvent {
      return finalizeEvent({ kind, tags, content, created_at: createdAt }, secret)
    }
  }
}

/** A read-only NIP-01 relay on localhost. */
export async function startLocalNostrRelay(
  events: readonly NostrEvent[]
): Promise<{ url: string; close(): Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the only client is the session under test.
      const [type, subscription, filter] = JSON.parse(String(data)) as [string, string, Filter]
      if (type !== 'REQ') {
        return
      }
      for (const event of events.filter((candidate) => matchFilter(filter, candidate))) {
        socket.send(JSON.stringify(['EVENT', subscription, event]))
      }
      socket.send(JSON.stringify(['EOSE', subscription]))
    })
  })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a listening TCP server has an AddressInfo.
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
