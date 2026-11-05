import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyRouterExitEvent } from './daemon-pty-router-events'

type Internals = {
  activeSessionIds: Set<string>
  sessionIncarnations: Map<string, string>
  hostLossSessionIds: Set<string>
  probeEndpoint: (socketPath: string) => Promise<boolean>
  recoverAfterEndpointLoss: () => void
}

// A previous-protocol host kept across an update has no respawn; when it died (2026-10-28) its panes kept
// showing connected with a frozen frame because nothing reported their PTYs gone.
function legacyAdapter(reachable: () => boolean): {
  internals: Internals
  exits: DaemonPtyRouterExitEvent[]
} {
  const adapter = new DaemonPtyAdapter({
    socketPath: '/unused',
    tokenPath: '/unused',
    protocolVersion: 52
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Internals names protected members the adapter declares; the test drives only those.
  const internals = adapter as unknown as Internals
  internals.activeSessionIds.add('a')
  internals.activeSessionIds.add('b')
  internals.sessionIncarnations.set('a', 'inc-a')
  internals.probeEndpoint = async () => reachable()
  const exits: DaemonPtyRouterExitEvent[] = []
  adapter.onExit((payload) => exits.push(payload))
  return { internals, exits }
}

describe('a host that cannot be respawned', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports every PTY lost, keeping history, once its endpoint stays gone', async () => {
    vi.useFakeTimers()
    const { internals, exits } = legacyAdapter(() => false)
    internals.recoverAfterEndpointLoss()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(exits.map((exit) => exit.id).sort()).toEqual(['a', 'b'])
    expect(exits.every((exit) => exit.hostLost === true)).toBe(true)
    expect(exits.find((exit) => exit.id === 'a')?.incarnationId).toBe('inc-a')
    expect(internals.activeSessionIds.size).toBe(0)
    expect([...internals.hostLossSessionIds].sort()).toEqual(['a', 'b'])
  })

  it('reports nothing when the endpoint answers again', async () => {
    vi.useFakeTimers()
    const { internals, exits } = legacyAdapter(() => true)
    internals.recoverAfterEndpointLoss()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(exits).toEqual([])
    expect(internals.activeSessionIds.size).toBe(2)
  })
})
