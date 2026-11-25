import { describe, expect, it } from 'vitest'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { ProviderRelayInfo } from '../daemon/protocol/daemon-provider-relay-protocol'
import {
  dropListedProviderRelay,
  keptProviderRelayOutstanding,
  listKeptProviderRelays,
  registerReattachableProviderRelayAgent
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
  it('are opened once only by an integration that opens ended agents, and unread output is never dropped by a failed open', async () => {
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
          ? { relays: [ended('c', 'live-only', true), ended('d', 'live-only', false)] }
          : {}
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory calls only these members
    await listKeptProviderRelays(async () => [client as unknown as DaemonClient])
    // A failed or refused open keeps unread output with the daemon; one with nothing unread is closed.
    dropListedProviderRelay('c', true)
    dropListedProviderRelay('d', true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toEqual([{ relayId: 'r-d' }])
  })
})
