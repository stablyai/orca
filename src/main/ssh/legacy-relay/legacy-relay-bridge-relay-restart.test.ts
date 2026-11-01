/** Relay restarts reuse socket and pty-1 ids; identify panes by endpoint plus relay-reported incarnation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import {
  ENDPOINT,
  type FakeRelay,
  fakeClient,
  lease,
  newFakeRelay,
  PTY,
  TARGET
} from './legacy-relay-fake-relay.test-fixture'
import { LegacyRelayPaneOwners } from './legacy-relay-pane-owners'
import { LegacyRelayPaneStops } from './legacy-relay-pane-stops'
import {
  LegacyRelayTargetBridge,
  type LegacyRelayTargetBridgeDeps
} from './legacy-relay-target-bridge'

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

  it('ignores the restarted relay’s exit report until its listing shows the pane’s own shell', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge({
      openClient: async () => {
        const client = fakeClient(relay)
        const list = client.list.bind(client)
        client.list = async () => {
          // The replacement's own pty-1 exits after the reconnect, before its listing lands.
          if (relay.clients.length > 1) {
            client.emitExit('pty-1', 9)
          }
          return list()
        }
        relay.clients.push(client)
        return client
      }
    })
    await subject.refresh()
    relay.clients[0].drop()
    relay.incarnations.set('pty-1', 'inc-2')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(relay.clients).toHaveLength(2)
    expect(events.exits).toEqual([])
    expect(leases[0].state).toBe('detached')
  })

  it('keeps the same relay’s exit report that raced its reconnect listing', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge({
      openClient: async () => {
        const client = fakeClient(relay)
        const list = client.list.bind(client)
        client.list = async () => {
          const rows = await list()
          // The shell exits after the reconnected relay answered, before its listing lands.
          if (relay.clients.length > 1) {
            client.emitExit('pty-1', 3)
          }
          return rows
        }
        relay.clients.push(client)
        return client
      }
    })
    await subject.refresh()
    relay.clients[0].drop()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(events.exits).toEqual([PTY])
    expect(leases[0].state).toBe('terminated')
    expect(subject.snapshot()).toEqual([])
  })

  it('takes an exit report on the connection that listed the pane, even after a refused attach', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    let exhaustive = true
    const subject = bridge({
      listEndpoints: async () => ({ kind: 'listed', endpoints: [ENDPOINT], exhaustive })
    })
    await subject.refresh()
    exhaustive = false
    relay.attachError = new Error('PTY busy')
    await expect(subject.attach(PTY)).resolves.toEqual({ status: 'unverifiable' })
    relay.clients[0].emitExit('pty-1', 4)
    expect(events.exits).toEqual([PTY])
    expect(leases[0].state).toBe('terminated')
  })

  it('takes an exit report on the connection that listed the pane after a listing missed it', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    // A second pane keeps the connection open.
    leases = [lease(), lease({ ptyId: 'pty-2', tabId: 'tab-2', leafId: 'leaf-2' })]
    relay.ptys.add('pty-2')
    let exhaustive = true
    const subject = bridge({
      listEndpoints: async () => ({ kind: 'listed', endpoints: [ENDPOINT], exhaustive })
    })
    await subject.refresh()
    // The relay answers without the pane while the census is incomplete: not yet proof.
    exhaustive = false
    relay.ptys.delete('pty-1')
    await subject.refresh()
    expect(subject.snapshot()).toContainEqual(expect.objectContaining({ state: 'unverifiable' }))
    expect(relay.clients[0].closed).toBe(false)
    relay.clients[0].emitExit('pty-1', 6)
    expect(events.exits).toEqual([PTY])
    expect(leases[0].state).toBe('terminated')
    expect(leases[1].state).toBe('detached')
  })

  it('reattaches the same shell when the relay lists its incarnation again', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    relay.clients[0].drop()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(subject.snapshot()).toEqual([expect.objectContaining({ state: 'live' })])
    subject.write(PTY, 'ls\r')
    expect(relay.clients.at(-1)!.writes).toEqual(['ls\r'])
  })

  it('keeps an epoch-scoped exit reported before the reconnect listing, even when incomplete', async () => {
    leases = [lease({ ptyId: 'pty2:epoch-a:1' })]
    relay.ptys = new Set(['pty2:epoch-a:1'])
    let exhaustive = true
    const subject = bridge({
      listEndpoints: async () => ({ kind: 'listed', endpoints: [ENDPOINT], exhaustive }),
      openClient: async () => {
        const client = fakeClient(relay)
        const list = client.list.bind(client)
        client.list = async () => {
          if (relay.clients.length > 1) {
            client.emitExit('pty2:epoch-a:1', 5)
            relay.ptys.clear()
          }
          return list()
        }
        relay.clients.push(client)
        return client
      }
    })
    await subject.refresh()
    exhaustive = false
    relay.clients[0].drop()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(events.exits).toEqual([toAppSshPtyId(TARGET, 'pty2:epoch-a:1')])
    expect(leases[0].state).toBe('terminated')
  })

  it('never binds an epoch-scoped id to a restart, whose ids carry a new epoch', async () => {
    leases = [lease({ ptyId: 'pty2:epoch-a:1' })]
    relay.ptys = new Set(['pty2:epoch-a:1'])
    const subject = bridge()
    await subject.refresh()
    relay.clients[0].drop()
    relay.ptys = new Set(['pty2:epoch-b:1'])
    await vi.advanceTimersByTimeAsync(2_000)
    subject.write(toAppSshPtyId(TARGET, 'pty2:epoch-a:1'), 'ls\r')
    expect(relay.clients.flatMap((client) => client.writes)).toEqual([])
  })
})
