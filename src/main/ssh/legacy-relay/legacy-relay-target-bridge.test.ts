import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { LegacyRelayEndpoint, LegacyRelayEndpointListing } from './legacy-relay-endpoints'
import {
  ENDPOINT,
  type FakeRelay,
  fakeClient,
  lease,
  newFakeRelay,
  PTY,
  TARGET
} from './legacy-relay-fake-relay.test-fixture'
import { LegacyRelayPaneStops } from './legacy-relay-pane-stops'
import { LegacyRelayPaneOwners } from './legacy-relay-pane-owners'
import {
  LegacyRelayTargetBridge,
  type LegacyRelayTargetBridgeDeps
} from './legacy-relay-target-bridge'

let relay: FakeRelay
let owners: LegacyRelayPaneOwners
let leases: SshRemotePtyLease[]
let listing: LegacyRelayEndpointListing
let endpointExited: boolean
let stops: LegacyRelayPaneStops
let events: { data: string[]; exits: string[]; exitedTelemetry: number; panesChanged: number }

/** Persists stops onto the leases, as the store does, so a fresh instance models a restart. */
function paneStops(): LegacyRelayPaneStops {
  return new LegacyRelayPaneStops(TARGET, () => ({
    leases: () => leases.filter((row) => row.state !== 'terminated'),
    recordStop: (_target, relayPtyId, pendingKill) => {
      leases = leases.map((row) => (row.ptyId === relayPtyId ? { ...row, pendingKill } : row))
    },
    retireLease: (_target, relayPtyId) => retire(relayPtyId)
  }))
}

/** As the store's retire records: terminated, and any stop it carried delivered. */
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
      // As the registry wires it.
      stops.exited(id)
    },
    onTerminalExited: () => {
      events.exitedTelemetry += 1
    },
    // As the registry keeps them: one target's owners outlive each bridge.
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
  it('serves a leased pane its relay lists, forwarding output only once attached', async () => {
    const subject = bridge()
    await subject.refresh()
    expect(subject.snapshot()).toEqual([
      { ptyId: PTY, targetId: TARGET, tabId: 'tab-1', leafId: 'leaf-1', state: 'live' }
    ])
    relay.clients[0].emitData('pty-1', 'early')
    await expect(subject.attach(PTY)).resolves.toMatchObject({
      status: 'attached',
      replay: 'SCREEN'
    })
    relay.clients[0].emitData('pty-1', 'late')
    subject.write(PTY, 'ls\r')
    expect(events.data).toEqual(['late'])
    expect(relay.clients[0].writes).toEqual(['ls\r'])
  })

  it('names a live leased pane by its pane key, with what its relay claims about it', async () => {
    const leafId = '33333333-3333-4333-8333-333333333333'
    leases = [lease({ leafId })]
    const subject = bridge({
      openClient: async () => {
        const client = fakeClient(relay)
        client.list = async () => [
          { relayPtyId: 'pty-1', incarnationId: 'inc-1', terminalHandle: 'term_a' }
        ]
        relay.clients.push(client)
        return client
      }
    })
    await subject.refresh()
    expect(subject.livePaneForKey(`tab-1:${leafId}`)).toEqual({
      ptyId: PTY,
      incarnationId: 'inc-1',
      terminalHandle: 'term_a'
    })
    // A pane moved to another tab keeps the key its shell was started with.
    expect(subject.livePaneForKey(`tab-2:${leafId}`)).toMatchObject({ ptyId: PTY })
    expect(subject.livePaneForKey('tab-1:44444444-4444-4444-8444-444444444444')).toBeNull()
    expect(subject.livePaneForKey('tab-1:not-a-leaf')).toBeNull()
    relay.clients[0].drop()
    // Unverifiable is not live: a pane the relay cannot vouch for names nobody.
    expect(subject.livePaneForKey(`tab-1:${leafId}`)).toBeNull()
  })

  it('retires the pane and hangs up when its relay reports the exit', async () => {
    const subject = bridge()
    await subject.refresh()
    await subject.attach(PTY)
    relay.clients[0].emitExit('pty-1', 0)
    expect(events.exits).toEqual([PTY])
    expect(events.exitedTelemetry).toBe(1)
    expect(leases[0].state).toBe('terminated')
    expect(subject.snapshot()).toEqual([])
    expect(relay.clients[0].closed).toBe(true)
  })

  it('reads a dropped connection as unverifiable and reattaches once the relay answers', async () => {
    const subject = bridge()
    await subject.refresh()
    relay.openError = new Error('ssh down')
    relay.clients[0].drop()
    expect(subject.snapshot()[0].state).toBe('unverifiable')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(subject.snapshot()[0].state).toBe('unverifiable')
    expect(leases[0].state).toBe('detached')
    relay.openError = null
    await vi.advanceTimersByTimeAsync(4_000)
    expect(subject.snapshot()[0].state).toBe('live')
    expect(events.exits).toEqual([])
  })

  it('answers an attach for a leased pane it cannot reach as unverifiable, never exited', async () => {
    listing = { kind: 'unverifiable' }
    const subject = bridge()
    await subject.refresh()
    // Published before any relay answers, so the tab waits instead of starting a second shell.
    expect(subject.snapshot()).toEqual([
      { ptyId: PTY, targetId: TARGET, tabId: 'tab-1', leafId: 'leaf-1', state: 'unverifiable' }
    ])
    const attached = subject.attach(PTY)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(attached).resolves.toEqual({ status: 'unverifiable' })
    expect(leases[0].state).toBe('detached')
  })

  it('serves a pane whose relay could not be asked at first once it answers', async () => {
    relay.openError = new Error('owner claim timed out')
    const subject = bridge()
    await subject.refresh()
    expect(subject.snapshot()[0].state).toBe('unverifiable')
    relay.openError = null
    await vi.advanceTimersByTimeAsync(2_000)
    expect(subject.snapshot()[0].state).toBe('live')
    await expect(subject.attach(PTY)).resolves.toMatchObject({ status: 'attached' })
  })

  it('retires a lease only when every relay for the target answered without it', async () => {
    relay.ptys.clear()
    await bridge().refresh()
    expect(leases[0].state).toBe('terminated')
    // Never seen live in this session, so no exit is counted for it.
    expect(events.exitedTelemetry).toBe(0)
  })

  it('keeps a lease when a relay could not be asked', async () => {
    relay.ptys.clear()
    relay.openError = new Error('refused')
    await bridge().refresh()
    expect(leases[0].state).toBe('detached')
  })

  it('keeps a lease when a relay may run that no endpoint accounts for', async () => {
    relay.ptys.clear()
    listing = { kind: 'listed', endpoints: [ENDPOINT], exhaustive: false }
    await bridge().refresh()
    expect(leases[0].state).toBe('detached')
  })

  it('counts a relay whose socket is provably dead as holding nothing', async () => {
    relay.openError = new Error('ECONNREFUSED')
    endpointExited = true
    await bridge().refresh()
    expect(leases[0].state).toBe('terminated')
  })

  it('retires on a proven-exited attach refusal, and only re-lists an ambiguous one', async () => {
    const subject = bridge()
    await subject.refresh()
    relay.attachError = new Error('PTY "pty-1" not found')
    await expect(subject.attach(PTY)).resolves.toEqual({ status: 'unverifiable' })
    expect(leases[0].state).toBe('detached')
    expect(subject.snapshot()[0].state).toBe('unverifiable')
    // Re-listed on backoff, never in a tight loop.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(subject.snapshot()[0].state).toBe('live')
    relay.attachError = new Error('PTY "pty-1" not found (process exited)')
    await expect(subject.attach(PTY)).resolves.toEqual({ status: 'exited' })
    expect(leases[0].state).toBe('terminated')
  })

  it('never serves a lease a stop is pending for, or one a newer pane won', async () => {
    leases = [
      lease({ pendingKill: { requestedAt: 1, attempts: 1 } }),
      lease({ ptyId: 'pty-2', supersededBy: 'pty-3' }),
      lease({ ptyId: 'pty-4', tabId: undefined })
    ]
    relay.ptys = new Set(['pty-1', 'pty-2', 'pty-4'])
    const subject = bridge()
    await subject.refresh()
    expect(subject.snapshot()).toEqual([])
    expect(stops.owes(PTY)).toBe(false)
    // Listed only for its stop, which an unfenced legacy id never proves, so it is dropped.
    expect(relay.shutdowns).toEqual([])
    expect(leases[0].pendingKill).toBeUndefined()
  })

  it('never lists a relay for a lease a newer pane won', async () => {
    leases = [lease({ supersededBy: 'pty-3' }), lease({ ptyId: 'pty-4', tabId: undefined })]
    relay.ptys = new Set(['pty-1', 'pty-4'])
    await bridge().refresh()
    expect(relay.clients).toEqual([])
  })

  it('stops a closed tab’s shell through the relay and retires it on the relay’s exit report', async () => {
    const subject = bridge()
    await subject.refresh()
    await expect(stops.stop(PTY, subject)).resolves.toEqual({ status: 'requested' })
    expect(relay.shutdowns).toEqual(['pty-1'])
    expect(events.exits).toEqual([PTY])
    expect(leases[0].state).toBe('terminated')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(relay.shutdowns).toEqual(['pty-1'])
  })

  it('retires a stopped shell once a listing proves it gone, without an exit report', async () => {
    relay.exitOnShutdown = false
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    await stops.stop(PTY, subject)
    expect(leases[0].state).toBe('detached')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(leases[0].state).toBe('terminated')
    expect(stops.size).toBe(0)
  })

  it('holds a close for an unreachable relay as unverifiable and sends it once the relay answers', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    relay.openError = new Error('ssh down')
    relay.clients[0].drop()
    await expect(stops.stop(PTY, subject)).resolves.toEqual({ status: 'unverifiable' })
    expect(relay.shutdowns).toEqual([])
    // Loss of contact is never exit.
    expect(leases[0].state).toBe('detached')
    expect(events.exits).toEqual([])
    relay.openError = null
    await vi.advanceTimersByTimeAsync(2_000)
    // Fenced to the process the tab ran.
    expect(relay.shutdowns).toEqual(['pty-1#inc-1'])
    expect(leases[0].state).toBe('terminated')
  })

  it('keeps the identity a first close saw when the tab’s close repeats while unreachable', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    relay.openError = new Error('ssh down')
    relay.clients[0].drop()
    await stops.stop(PTY, subject)
    await vi.advanceTimersByTimeAsync(2_000)
    await stops.stop(PTY, subject)
    relay.openError = null
    await vi.advanceTimersByTimeAsync(10_000)
    expect(relay.shutdowns).toEqual(['pty-1#inc-1'])
  })

  it('never stops a different process that took a closed tab’s recycled relay id', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    relay.openError = new Error('ssh down')
    relay.clients[0].drop()
    await stops.stop(PTY, subject)
    relay.incarnations.set('pty-1', 'inc-2')
    relay.openError = null
    await vi.advanceTimersByTimeAsync(10_000)
    expect(relay.shutdowns).toEqual([])
    expect(stops.size).toBe(0)
    // The closed tab's lease ends, so the stranger is never served under it.
    expect(leases[0].state).toBe('terminated')
    expect(subject.snapshot()).toEqual([])
  })

  it('never re-aims a repeated close at a process that took the closed tab’s relay id', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    relay.openError = new Error('ssh down')
    relay.clients[0].drop()
    await stops.stop(PTY, subject)
    // A restarted relay reuses the id for another shell, and the close repeats before any flush.
    const client = fakeClient(relay)
    const recycled = {
      paneState: () => 'live' as const,
      paneReplaced: () => false,
      liveRoute: () => ({ client, relayPtyId: 'pty-1' }),
      listedIncarnation: () => 'inc-2',
      refresh: async () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stop() reads only these members.
    await stops.stop(PTY, recycled as unknown as LegacyRelayTargetBridge)
    expect(relay.shutdowns).toEqual([])
    expect(leases[0].state).toBe('terminated')
  })

  it('proves a stop only by the relay’s exit report, never by the stop’s reply', async () => {
    const epochPty = toAppSshPtyId(TARGET, 'pty2:epoch:1')
    leases = [lease({ ptyId: 'pty2:epoch:1' })]
    relay.ptys = new Set(['pty2:epoch:1'])
    const subject = bridge()
    await subject.refresh()
    await expect(stops.stopAndWait(epochPty, subject, Date.now() + 5_000)).resolves.toBe('reported')
  })

  it('settles on the relay’s exit report even when the stop’s own reply is lost', async () => {
    const epochPty = toAppSshPtyId(TARGET, 'pty2:epoch:1')
    leases = [lease({ ptyId: 'pty2:epoch:1' })]
    const client = fakeClient(relay)
    client.shutdown = async () => {
      stops.exited(epochPty)
      throw new Error('request timed out')
    }
    const lostReply = {
      paneState: () => 'live' as const,
      paneReplaced: () => false,
      liveRoute: () => ({ client, relayPtyId: 'pty2:epoch:1' }),
      listedIncarnation: () => undefined,
      refresh: async () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stop() reads only these members.
    const target = lostReply as unknown as LegacyRelayTargetBridge
    await expect(stops.stopAndWait(epochPty, target, Date.now() + 5_000)).resolves.toBe('reported')
  })

  it('still settles on an exit report that trails a failed stop reply', async () => {
    const epochPty = toAppSshPtyId(TARGET, 'pty2:epoch:1')
    leases = [lease({ ptyId: 'pty2:epoch:1' })]
    relay.ptys = new Set(['pty2:epoch:1'])
    relay.shutdownError = new Error('request timed out')
    const subject = bridge()
    await subject.refresh()
    const settled = stops.stopAndWait(epochPty, subject, Date.now() + 5_000)
    await vi.advanceTimersByTimeAsync(100)
    relay.clients[0].emitExit('pty2:epoch:1', 0)
    await expect(settled).resolves.toBe('reported')
  })

  it('still sees an unfenced stop’s exit report that trails its reply, never re-serving the pane', async () => {
    relay.exitOnShutdown = false
    const subject = bridge()
    await subject.refresh()
    const settled = stops.stopAndWait(PTY, subject, Date.now() + 5_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.shutdowns).toEqual(['pty-1'])
    expect(subject.snapshot()).toEqual([])
    relay.clients[0].emitExit('pty-1', 0)
    await expect(settled).resolves.toBe('reported')
  })

  it('still sees an unfenced stop’s exit report after its reply timed out', async () => {
    relay.shutdownError = new Error('request timed out')
    const subject = bridge()
    await subject.refresh()
    const settled = stops.stopAndWait(PTY, subject, Date.now() + 5_000)
    await vi.advanceTimersByTimeAsync(100)
    expect(subject.snapshot()).toEqual([])
    relay.clients[0].emitExit('pty-1', 0)
    await expect(settled).resolves.toBe('reported')
  })

  it('leaves a taken stop unproven while no exit report or complete listing confirms it', async () => {
    const epochPty = toAppSshPtyId(TARGET, 'pty2:epoch:1')
    leases = [lease({ ptyId: 'pty2:epoch:1' })]
    relay.ptys = new Set(['pty2:epoch:1'])
    relay.exitOnShutdown = false
    // A relay may run that no endpoint accounts for, so absence from the listing is not exit.
    listing = { kind: 'listed', endpoints: [ENDPOINT], exhaustive: false }
    const subject = bridge()
    await subject.refresh()
    const settled = stops.stopAndWait(epochPty, subject, Date.now() + 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(settled).resolves.toBeNull()
    expect(relay.shutdowns).toEqual(['pty2:epoch:1'])
  })

  it('never attaches a pane whose tab closed while the attach waited for its relay', async () => {
    const epochPty = toAppSshPtyId(TARGET, 'pty2:epoch:1')
    leases = [lease({ ptyId: 'pty2:epoch:1' })]
    relay.ptys = new Set(['pty2:epoch:1'])
    relay.openError = new Error('ssh down')
    const subject = bridge()
    await subject.refresh()
    const attach = subject.attach(epochPty)
    // The tab closes while the attach waits for the unreachable relay.
    await stops.stop(epochPty, null)
    relay.openError = null
    relay.shutdownError = new Error('timed out')
    await subject.refresh()
    await expect(attach).resolves.toEqual({ status: 'not-bridged' })
    expect(relay.clients.every((client) => client.writes.length === 0)).toBe(true)
  })

  it('sends a close recorded while disconnected once the next bridge lists the pane', async () => {
    const epochPty = toAppSshPtyId(TARGET, 'pty2:epoch:1')
    leases = [lease({ ptyId: 'pty2:epoch:1' })]
    relay.ptys = new Set(['pty2:epoch:1'])
    await expect(stops.stop(epochPty, null)).resolves.toEqual({ status: 'unverifiable' })
    expect(leases[0].state).toBe('detached')
    await bridge().refresh()
    expect(relay.shutdowns).toEqual(['pty2:epoch:1'])
  })

  it('sends a close recorded while disconnected after a restart before the reconnect', async () => {
    const epochPty = toAppSshPtyId(TARGET, 'pty2:epoch:1')
    leases = [lease({ ptyId: 'pty2:epoch:1' })]
    relay.ptys = new Set(['pty2:epoch:1'])
    await stops.stop(epochPty, null)
    // Restart: only the persisted leases survive.
    stops = paneStops()
    const subject = bridge()
    await subject.refresh()
    expect(relay.shutdowns).toEqual(['pty2:epoch:1'])
    // A closed tab's shell is stopped, never offered back as a pane to reattach.
    expect(subject.snapshot()).toEqual([])
    expect(leases[0]).toMatchObject({ state: 'terminated' })
    expect(leases[0].pendingKill).toBeUndefined()
  })

  it('keeps the first close’s record when the tab’s close repeats', async () => {
    const epochPty = toAppSshPtyId(TARGET, 'pty2:epoch:1')
    leases = [lease({ ptyId: 'pty2:epoch:1' })]
    await stops.stop(epochPty, null)
    const first = leases[0].pendingKill
    await vi.advanceTimersByTimeAsync(5_000)
    await stops.stop(epochPty, null)
    expect(leases[0].pendingKill).toBe(first)
  })

  it('restores a fenced stop across a restart and sends it only to the same process', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    relay.openError = new Error('ssh down')
    relay.clients[0].drop()
    await stops.stop(PTY, subject)
    subject.dispose()
    stops = paneStops()
    relay.openError = null
    await bridge().refresh()
    expect(relay.shutdowns).toEqual(['pty-1#inc-1'])
  })

  it('drops a restored stop whose relay id now names another process, never serving it', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    relay.openError = new Error('ssh down')
    relay.clients[0].drop()
    await stops.stop(PTY, subject)
    subject.dispose()
    stops = paneStops()
    relay.incarnations.set('pty-1', 'inc-2')
    relay.openError = null
    const next = bridge()
    await next.refresh()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(relay.shutdowns).toEqual([])
    expect(leases[0]).toMatchObject({ state: 'terminated' })
    expect(leases[0].pendingKill).toBeUndefined()
    expect(next.snapshot()).toEqual([])
  })

  it('stops serving an unfenced legacy pane once its one stop failed', async () => {
    const subject = bridge()
    await subject.refresh()
    relay.shutdownError = new Error('timed out')
    await stops.stop(PTY, subject)
    await vi.advanceTimersByTimeAsync(0)
    expect(subject.snapshot()).toEqual([])
    expect(subject.livePaneCount()).toBe(0)
  })

  it('never serves an unfenced legacy pane again after its tab closed and Orca restarted', async () => {
    await expect(stops.stop(PTY, null)).resolves.toEqual({ status: 'unverifiable' })
    stops = paneStops()
    const subject = bridge()
    await subject.refresh()
    expect(subject.snapshot()).toEqual([])
    expect(relay.shutdowns).toEqual([])
  })

  it('never replays a blind close for a legacy id that could name another shell', async () => {
    await stops.stop(PTY, null)
    await bridge().refresh()
    expect(relay.shutdowns).toEqual([])
    // The tab closed, so its lease ends as any closed tab's does.
    expect(leases[0].state).toBe('terminated')
  })

  it('never replays a fenced legacy stop to a relay that no longer reports the incarnation', async () => {
    relay.incarnations.set('pty-1', 'inc-1')
    const subject = bridge()
    await subject.refresh()
    relay.openError = new Error('ssh down')
    relay.clients[0].drop()
    await stops.stop(PTY, subject)
    // A restarted or downgraded relay lists the same id with no identity, and may ignore the fence.
    relay.incarnations.clear()
    relay.openError = null
    await vi.advanceTimersByTimeAsync(10_000)
    expect(relay.shutdowns).toEqual([])
  })

  it('never replays an unfenced legacy stop on a later connection, which may be a new relay', async () => {
    const subject = bridge()
    await subject.refresh()
    relay.shutdownError = new Error('timed out')
    await expect(stops.stop(PTY, subject)).resolves.toEqual({ status: 'unverifiable' })
    relay.shutdownError = null
    relay.clients[0].drop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(relay.shutdowns).toEqual([])
    // One try only: the lease ends as any closed tab's does, so no later relay is ever asked.
    expect(leases[0].state).toBe('terminated')
    expect(subject.snapshot()).toEqual([])
  })

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
    // The pane that left hands its late viewer back; the registry routes it to the current bridge.
    successor.detach(PTY, lateResult.status === 'attached' ? lateResult.acquisitionId : -1)
    relay.clients.at(-1)?.emitData('pty-1', 'still viewed')
    expect(events.data).toEqual(['still viewed'])
  })

  describe('two relays that list the same relay id', () => {
    const OTHER: LegacyRelayEndpoint = { ...ENDPOINT, endpoint: '/home/me/.orca-remote/b.sock' }
    let other: FakeRelay
    const clientOf = (endpoint: LegacyRelayEndpoint) =>
      (endpoint.endpoint === OTHER.endpoint ? other : relay).clients.at(-1)!
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

    it('keeps the attached relay when a second one later lists the same id', async () => {
      const subject = twoRelays()
      await subject.refresh()
      await expect(subject.attach(PTY)).resolves.toMatchObject({ status: 'attached' })
      other.ptys.add('pty-1')
      listing = { kind: 'listed', endpoints: [ENDPOINT, OTHER], exhaustive: true }
      await subject.refresh()
      subject.write(PTY, 'ls\r')
      expect(clientOf(ENDPOINT).writes).toEqual(['ls\r'])
      expect(clientOf(OTHER).writes).toEqual([])
      // Only the owning relay speaks for the pane.
      clientOf(OTHER).emitData('pty-1', 'foreign')
      clientOf(OTHER).emitExit('pty-1', 0)
      expect(events.data).toEqual([])
      expect(events.exits).toEqual([])
      expect(leases[0].state).toBe('detached')
    })

    it('retires the pane when its own relay answers without it, never moving it to the other', async () => {
      const subject = twoRelays()
      await subject.refresh()
      relay.ptys.delete('pty-1')
      other.ptys.add('pty-1')
      listing = { kind: 'listed', endpoints: [ENDPOINT, OTHER], exhaustive: true }
      await subject.refresh()
      expect(leases[0].state).toBe('terminated')
      expect(subject.snapshot()).toEqual([])
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
      // Once no relay lists it, it is gone.
      relay.ptys.delete('pty-1')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(leases[0].state).toBe('terminated')
    })

    it('never adopts the one relay listing an id while another could not be asked', async () => {
      other.ptys.add('pty-1')
      relay.openError = new Error('ssh down')
      listing = { kind: 'listed', endpoints: [ENDPOINT, OTHER], exhaustive: true }
      const subject = twoRelays()
      await subject.refresh()
      expect(subject.snapshot()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
      // The unreachable relay answers and both list the id: still nobody's.
      relay.openError = null
      await vi.advanceTimersByTimeAsync(10_000)
      expect(subject.snapshot()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
      expect(other.clients.flatMap((client) => client.writes)).toEqual([])
    })

    it('never adopts the one relay listing an id while the census may have missed another', async () => {
      listing = { kind: 'listed', endpoints: [ENDPOINT], exhaustive: false }
      const subject = twoRelays()
      await subject.refresh()
      expect(subject.snapshot()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
      // The census later accounts for every relay, and the missed one runs the same id.
      other.ptys.add('pty-1')
      listing = { kind: 'listed', endpoints: [ENDPOINT, OTHER], exhaustive: true }
      await vi.advanceTimersByTimeAsync(10_000)
      expect(subject.snapshot()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
      subject.write(PTY, 'ls\r')
      expect(relay.clients.flatMap((client) => client.writes)).toEqual([])
    })

    it('serves an epoch-scoped id from its one relay even while the census may have missed one', async () => {
      const epochPty = toAppSshPtyId(TARGET, 'pty2:epoch:1')
      leases = [lease({ ptyId: 'pty2:epoch:1' })]
      relay.ptys = new Set(['pty2:epoch:1'])
      listing = { kind: 'listed', endpoints: [ENDPOINT], exhaustive: false }
      const subject = twoRelays()
      await subject.refresh()
      expect(subject.snapshot()).toEqual([
        expect.objectContaining({ ptyId: epochPty, state: 'live' })
      ])
    })

    it('keeps the owning relay across a reconnect, when both relays list the id', async () => {
      const first = twoRelays()
      await first.refresh()
      first.dispose()
      other.ptys.add('pty-1')
      listing = { kind: 'listed', endpoints: [ENDPOINT, OTHER], exhaustive: true }
      const successor = twoRelays()
      await successor.refresh()
      await expect(successor.attach(PTY)).resolves.toMatchObject({ status: 'attached' })
      successor.write(PTY, 'ls\r')
      expect(clientOf(ENDPOINT).writes).toEqual(['ls\r'])
      expect(clientOf(OTHER).writes).toEqual([])
    })

    it('keeps an exit the relay reported while its listing was in flight', async () => {
      const subject = bridge({
        openClient: async () => {
          const client = fakeClient(relay)
          const list = client.list.bind(client)
          client.list = async () => {
            const rows = await list()
            // The shell exits after the relay answered but before the pane has an owner.
            client.emitExit('pty-1', 3)
            return rows
          }
          relay.clients.push(client)
          return client
        }
      })
      await subject.refresh()
      expect(events.exits).toEqual([PTY])
      expect(leases[0].state).toBe('terminated')
      expect(subject.snapshot()).toEqual([])
    })
  })

  it('hangs up every connection on dispose and leaves the relays to their own grace', async () => {
    const subject = bridge()
    await subject.refresh()
    subject.dispose()
    expect(relay.clients.every((client) => client.closed)).toBe(true)
    expect(leases[0].state).toBe('detached')
    expect(subject.snapshot()).toEqual([])
  })
})
