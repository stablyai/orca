/** Relay restarts reuse socket and pty-1 ids; identify panes by endpoint plus relay-reported incarnation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../../shared/ssh-types'
import {
  ENDPOINT,
  type FakeRelay,
  fakeClient,
  lease,
  newFakeRelay,
  PTY,
  TARGET
} from './testing/legacy-relay-fake-relay.test-fixture'
import { LegacyRelayPaneOwners } from './legacy-relay-pane-owners'
import { LegacyRelayPaneStops } from './legacy-relay-pane-stops'
import { LegacyRelayTargetBridge } from './legacy-relay-target-bridge'
import type { LegacyRelayTargetBridgeDeps } from './legacy-relay-target-bridge-contract'

let relay: FakeRelay
let owners: LegacyRelayPaneOwners
let leases: SshRemotePtyLease[]
let stops: LegacyRelayPaneStops
let events: { data: string[]; exits: string[] }

function retire(relayPtyId: string): void {
  leases = leases.map((row) => (row.ptyId === relayPtyId ? { ...row, state: 'terminated' } : row))
}

function bridge(overrides: Partial<LegacyRelayTargetBridgeDeps> = {}): LegacyRelayTargetBridge {
  const subject: LegacyRelayTargetBridge = new LegacyRelayTargetBridge({
    targetId: TARGET,
    leases: () => leases.filter((row) => row.state !== 'terminated'),
    retireLease: retire,
    listEndpoints: async () => ({ kind: 'listed', endpoints: [ENDPOINT], exhaustive: true }),
    openClient: async () => {
      const client = fakeClient(relay)
      relay.clients.push(client)
      return client
    },
    endpointExited: async () => false,
    onPanesChanged: () => stops.flush(subject),
    onData: (_id, chunk) => events.data.push(chunk),
    onExit: (id) => {
      events.exits.push(id)
      stops.exited(id)
    },
    onTerminalExited: () => {},
    owners,
    ...overrides
  })
  return subject
}

beforeEach(() => {
  vi.useFakeTimers()
  relay = newFakeRelay()
  owners = new LegacyRelayPaneOwners()
  leases = [lease()]
  events = { data: [], exits: [] }
  stops = new LegacyRelayPaneStops(TARGET, () => ({
    leases: () => leases.filter((row) => row.state !== 'terminated'),
    recordStop: (_target, relayPtyId, pendingKill) => {
      leases = leases.map((row) => (row.ptyId === relayPtyId ? { ...row, pendingKill } : row))
    },
    retireLease: (_target, relayPtyId) => retire(relayPtyId)
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a relay restarted at the same socket', () => {
  it('never serves the shell it started under the reused id, nor reads its silence as exit', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    await subject.attach(PTY)
    relay.clients[0].drop()
    // The restarted relay numbers its new shell pty-1 again.
    relay.incarnations.set('pty-1', 'inc-2')
    await vi.advanceTimersByTimeAsync(2_000)
    const replacement = relay.clients.at(-1)!
    expect(replacement).not.toBe(relay.clients[0])
    expect(subject.snapshot()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
    const attached = subject.attach(PTY)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(attached).resolves.toEqual({ status: 'unverifiable' })
    subject.write(PTY, 'ls\r')
    replacement.emitData('pty-1', 'foreign')
    replacement.emitExit('pty-1', 0)
    expect(replacement.writes).toEqual([])
    expect(events.data).toEqual([])
    expect(events.exits).toEqual([])
    expect(leases[0].state).toBe('detached')
    // Nothing proves the first shell exited: the replacement dropping the id is not its exit.
    relay.ptys.delete('pty-1')
    const opened = relay.clients.length
    await vi.advanceTimersByTimeAsync(60_000)
    // Nothing can resolve it, so it schedules no reconnect of its own.
    expect(relay.clients).toHaveLength(opened)
    expect(relay.clients.every((client) => client.closed)).toBe(true)
    expect(subject.snapshot()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
    expect(leases[0].state).toBe('detached')
    // Closing the tab never stops the replacement.
    relay.ptys.add('pty-1')
    await stops.stop(PTY, subject)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(relay.shutdowns).toEqual([])
  })
})
