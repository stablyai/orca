import { describe, expect, it } from 'vitest'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { ProviderRelayInfo } from '../daemon/protocol/daemon-provider-relay-protocol'
import {
  keptProviderRelayOutstanding,
  listKeptProviderRelays,
  registerReattachableProviderRelayAgent,
  beginProviderRelayRunAsk,
  forgetProviderRelayRunVerdict,
  noteProviderRelayRunVerdict,
  providerRelayRunUnknown
} from './provider-relay-launch-inventory'

const ended = (chatKey: string, agent: string, unread: boolean): ProviderRelayInfo => ({
  relayId: `r-${chatKey}`,
  chatKey,
  agent,
  pid: 7,
  spawnedAtMs: 1,
  attached: false,
  exit: { code: 0, signal: null },
  nextSeq: unread ? 9 : 5,
  ackedSeq: 4,
  pendingCount: 0
})

describe('kept relays whose agent ended while no app was attached', () => {
  it('are opened once only by an integration that opens ended agents, and only an integration this build cannot reattach is ended at launch', async () => {
    registerReattachableProviderRelayAgent('opens-ended', { opensEnded: true })
    registerReattachableProviderRelayAgent('live-only')
    expect(keptProviderRelayOutstanding(ended('a', 'opens-ended', true))).toBe(true)
    expect(keptProviderRelayOutstanding(ended('b', 'opens-ended', false))).toBe(false)
    expect(keptProviderRelayOutstanding(ended('c', 'live-only', true))).toBe(false)

    const closed: unknown[] = []
    const client = {
      getDaemonIdentity: () => ({ providerRelay: true, pid: 1 }),
      onEvent: () => () => {},
      onDisconnected: () => () => {},
      request: async (type: string, payload: unknown) => {
        if (type === 'relayClose') {
          closed.push(payload)
        }
        return type === 'relayList'
          ? {
              relays: [
                ended('c', 'live-only', true),
                ended('d', 'live-only', false),
                // An integration this build can't reattach is ended; a daemon that names none isn't.
                { ...ended('f', 'other', false), exit: null },
                { ...ended('e', 'live-only', false), exit: null, agent: undefined }
              ]
            }
          : {}
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory calls only these members
    await listKeptProviderRelays(async () => [client as unknown as DaemonClient])
    await new Promise((resolve) => setImmediate(resolve))
    // Only the relay this build can't reattach is ended at launch; the rest wait for their chats.
    expect(closed).toEqual([{ relayId: 'r-f' }])
  })
})

describe("a chat's unknown run verdict", () => {
  it('is never written back by an ask that ends after its chat closed, while a reopened ask still records it', () => {
    beginProviderRelayRunAsk('c')
    forgetProviderRelayRunVerdict('c')
    noteProviderRelayRunVerdict('c', 'unknown')
    expect(providerRelayRunUnknown('c')).toBe(false)

    beginProviderRelayRunAsk('c')
    forgetProviderRelayRunVerdict('c')
    beginProviderRelayRunAsk('c')
    noteProviderRelayRunVerdict('c', 'unknown')
    noteProviderRelayRunVerdict('c', 'unknown')
    expect(providerRelayRunUnknown('c')).toBe(true)

    beginProviderRelayRunAsk('c')
    noteProviderRelayRunVerdict('c', null)
    expect(providerRelayRunUnknown('c')).toBe(true)
    forgetProviderRelayRunVerdict('c')
    expect(providerRelayRunUnknown('c')).toBe(false)
  })
})
