import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshRemotePtyLease } from '../../../../shared/ssh-types'
import type {
  LegacyRelayEndpoint,
  LegacyRelayEndpointListing
} from '../endpoints/legacy-relay-endpoints'
import {
  ENDPOINT,
  type FakeRelay,
  fakeClient,
  lease,
  newFakeRelay,
  PTY,
  TARGET
} from './testing/legacy-relay-fake-relay.test-fixture'
import { LegacyRelayPaneStops } from './legacy-relay-pane-stops'
import { LegacyRelayPaneOwners } from './legacy-relay-pane-owners'
import { LegacyRelayTargetBridge } from './legacy-relay-target-bridge'
import type { LegacyRelayTargetBridgeDeps } from './legacy-relay-target-bridge-contract'

let relay: FakeRelay
let owners: LegacyRelayPaneOwners
let leases: SshRemotePtyLease[]
let listing: LegacyRelayEndpointListing
let endpointExited: boolean
let stops: LegacyRelayPaneStops
let events: { data: string[]; exits: string[]; exitedTelemetry: number; panesChanged: number }

/** Persist stops on leases so replacing the instance models restart. */
function paneStops(): LegacyRelayPaneStops {
  return new LegacyRelayPaneStops(TARGET, () => ({
    leases: () => leases.filter((row) => row.state !== 'terminated'),
    recordStop: (_target, relayPtyId, pendingKill) => {
      leases = leases.map((row) => (row.ptyId === relayPtyId ? { ...row, pendingKill } : row))
    },
    retireLease: (_target, relayPtyId) => retire(relayPtyId)
  }))
}

function retire(relayPtyId: string): void {
  leases = leases.map((row) => {
    if (row.ptyId !== relayPtyId) {
      return row
    }
    const { pendingKill: _delivered, ...rest } = row
    return { ...rest, state: 'terminated' }
  })
}

function bridge(overrides: Partial<LegacyRelayTargetBridgeDeps> = {}): LegacyRelayTargetBridge {
  const subject: LegacyRelayTargetBridge = new LegacyRelayTargetBridge({
    targetId: TARGET,
    leases: () => leases.filter((row) => row.state !== 'terminated'),
    retireLease: retire,
    listEndpoints: async () => listing,
    openClient: async () => {
      if (relay.openError) {
        throw relay.openError
      }
      const client = fakeClient(relay)
      relay.clients.push(client)
      return client
    },
    endpointExited: async () => endpointExited,
    onPanesChanged: () => {
      events.panesChanged += 1
      stops.flush(subject)
    },
    onData: (_id, chunk) => events.data.push(chunk),
    onExit: (id) => {
      events.exits.push(id)
      stops.exited(id)
    },
    onTerminalExited: () => {
      events.exitedTelemetry += 1
    },
    // Ownership survives bridge replacement on reconnect.
    owners,
    ...overrides
  })
  return subject
}

beforeEach(() => {
  vi.useFakeTimers()
  relay = newFakeRelay()
  stops = paneStops()
  owners = new LegacyRelayPaneOwners()
  leases = [lease()]
  listing = { kind: 'listed', endpoints: [ENDPOINT], exhaustive: true }
  endpointExited = false
  events = { data: [], exits: [], exitedTelemetry: 0, panesChanged: 0 }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('one target’s legacy relay bridge', () => {
  it('never republishes a pane that exited while a refresh was asking its relay', async () => {
    const subject = bridge()
    await subject.refresh()
    await subject.attach(PTY)
    const client = relay.clients[0]
    let answer: (rows: { relayPtyId: string }[]) => void = () => {}
    client.list = () => new Promise((resolve) => (answer = resolve))
    const refreshing = subject.refresh()
    await vi.advanceTimersByTimeAsync(0)
    client.emitExit('pty-1', 0)
    // The listing was read before the exit, so it still names the terminal.
    answer([{ relayPtyId: 'pty-1' }])
    await refreshing
    expect(subject.snapshot()).toEqual([])
    expect(subject.liveRoute(PTY)).toBeNull()
    expect(events.exits).toEqual([PTY])
  })

  it('releases a late attach by its own acquisition, never the successor viewing the same pane', async () => {
    const replaced = bridge()
    await replaced.refresh()
    let answer: (reply: { replay: string }) => void = () => {}
    relay.clients[0].attach = () => new Promise((resolve) => (answer = resolve))
    const late = replaced.attach(PTY)
    await vi.advanceTimersByTimeAsync(0)
    // A reconnect replaces the bridge, and the remounted pane attaches to the new one.
    replaced.dispose()
    const successor = bridge()
    await successor.refresh()
    await expect(successor.attach(PTY)).resolves.toMatchObject({ status: 'attached' })
    answer({ replay: 'SCREEN' })
    const lateResult = await late
    expect(lateResult.status).toBe('attached')
    // Late viewer release must route to the successor bridge without releasing its current viewer.
    successor.detach(PTY, lateResult.status === 'attached' ? lateResult.acquisitionId : -1)
    relay.clients.at(-1)?.emitData('pty-1', 'still viewed')
    expect(events.data).toEqual(['still viewed'])
  })

  describe('two relays that list the same relay id', () => {
    const OTHER: LegacyRelayEndpoint = { ...ENDPOINT, endpoint: '/home/me/.orca-remote/b.sock' }
    let other: FakeRelay
    const twoRelays = (): LegacyRelayTargetBridge =>
      bridge({
        openClient: async (endpoint) => {
          const owner = endpoint.endpoint === OTHER.endpoint ? other : relay
          if (owner.openError) {
            throw owner.openError
          }
          const client = fakeClient(owner)
          owner.clients.push(client)
          return client
        }
      })

    beforeEach(() => {
      other = { ...relay, ptys: new Set(), clients: [], shutdowns: [], incarnations: new Map() }
    })

    it('serves neither relay when both list the id and neither held it', async () => {
      other.ptys.add('pty-1')
      listing = { kind: 'listed', endpoints: [ENDPOINT, OTHER], exhaustive: true }
      const subject = twoRelays()
      await subject.refresh()
      expect(subject.snapshot()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
      expect(leases[0].state).toBe('detached')
      // One claimant dropping it settles nothing: the one left may be the stranger.
      other.ptys.delete('pty-1')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(subject.snapshot()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
      subject.write(PTY, 'ls\r')
      expect(relay.clients.flatMap((client) => client.writes)).toEqual([])
      relay.ptys.delete('pty-1')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(leases[0].state).toBe('terminated')
    })
  })
})
