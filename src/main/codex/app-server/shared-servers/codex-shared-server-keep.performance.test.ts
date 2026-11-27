import { afterEach, describe, expect, it } from 'vitest'
import { installProviderRelayDurability } from '../../../provider-relay/app-provider-relays'
import { CodexSharedServerKeep, type CodexKeptServer } from './codex-shared-server-keep'
import { CodexSharedServerRecovery } from './codex-shared-server-recovery'
import type { CodexSharedServerLease } from './codex-shared-server-lease'

// A relayed shared server acks about once a second; each ack must ask only the chats handed
// frames since the last one to save, and read the floor only from chats holding queued frames.

function idleLeases(count: number, floorReads: { count: number }) {
  return Array.from({ length: count }, (_, at) => {
    const lease = {
      sessionId: `chat-${at}`,
      handedOff: false,
      queue: {
        pending: 0,
        firstSeq: () => {
          floorReads.count += 1
          return null
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the keep side reads only these members.
    return lease as unknown as CodexSharedServerLease
  })
}

function keptServer(leases: CodexSharedServerLease[]): CodexSharedServerKeep {
  const server = {
    leases: new Set(leases),
    router: { floor: () => null },
    recovery: new CodexSharedServerRecovery(
      () => {},
      () => 0
    ),
    physicalConnection: null,
    exited: false,
    pid: undefined,
    ended: () => {},
    stop: async () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are every member the keep side reads.
  return new CodexSharedServerKeep(server as unknown as CodexKeptServer)
}

describe('relayed shared server acks', () => {
  afterEach(() => installProviderRelayDurability(null))

  it.each([100, 1_000])('asks one streaming chat of %i to save per ack', async (chats) => {
    let barriers = 0
    installProviderRelayDurability(async () => {
      barriers += 1
      return true
    })
    const floorReads = { count: 0 }
    const leases = idleLeases(chats, floorReads)
    const keep = keptServer(leases)
    const acks = 50
    for (let ack = 0; ack < acks; ack += 1) {
      keep.dispatched(leases[0]!)
      await keep.durable(false)
      keep.floor()
    }
    expect(barriers).toBe(acks)
    expect(floorReads.count).toBe(0)
  })
})
