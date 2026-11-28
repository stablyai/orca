// Perf contract for #47783: fresh asks join a daemon start's listing while its cleanup still runs,
// so a slow close of a relay this build can't reattach is sent once, not once per ask.
import { expect, it, vi } from 'vitest'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { ProviderRelayInfo } from '../daemon/protocol/daemon-provider-relay-protocol'

const unsupported = (relayId: string): ProviderRelayInfo => ({
  relayId,
  chatKey: `chat-of-${relayId}`,
  agent: 'agent-of-a-newer-build',
  pid: 1,
  spawnedAtMs: 1,
  attached: false,
  exit: null,
  nextSeq: 1,
  ackedSeq: 0,
  pendingCount: 0
})

function daemonWithStuckClose(instance: string, relays: () => ProviderRelayInfo[]) {
  const closes: string[] = []
  const pending: (() => void)[] = []
  const client = {
    getDaemonIdentity: () => ({
      providerRelay: true,
      pid: 1,
      startedAtMs: 1,
      launchNonce: instance
    }),
    ensureConnectedWithin: async () => {},
    onEvent: () => () => {},
    onDisconnected: () => () => {},
    request: (type: string, payload?: { relayId?: string }) => {
      if (type === 'relayList') {
        return Promise.resolve({ relays: relays(), daemonInstance: instance })
      }
      if (type === 'relayClose') {
        closes.push(payload?.relayId ?? '')
        return new Promise<void>((resolve) => pending.push(resolve))
      }
      return Promise.resolve({})
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing and its cleanup read only these members.
  const daemonClient = client as unknown as DaemonClient
  return {
    client: daemonClient,
    closes,
    release: () => pending.splice(0).forEach((resolve) => resolve())
  }
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

it('sends one close per relay however many fresh asks arrive while it is pending', async () => {
  for (const asks of [100, 1_000]) {
    vi.resetModules()
    const inventory = await import('./provider-relay-launch-inventory')
    let listed = [unsupported('r-1')]
    const { client, closes, release } = daemonWithStuckClose(`start-${asks}`, () => listed)
    for (let i = 0; i < asks; i += 1) {
      void inventory.listProviderRelayInstance(client, `start-${asks}`, true)
      await flush()
    }
    expect(closes).toEqual(['r-1'])
    // Once that cleanup ends, a new relay this build can't reattach is still ended.
    release()
    await flush()
    listed = [unsupported('r-2')]
    void inventory.listProviderRelayInstance(client, `start-${asks}`, true)
    await flush()
    expect(closes).toEqual(['r-1', 'r-2'])
    release()
  }
})
