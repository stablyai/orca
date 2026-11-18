import { describe, expect, it } from 'vitest'
import { computeZotzMemoryGovernorDefaults } from '../../../shared/zotz/agent-queue/zotz-memory-governor-defaults'
import type { ZotzMemoryGovernorState } from './zotz-memory-governor-service'
import { ZotzAgentLaunchQueue } from './zotz-agent-launch-queue'

const GB = 1024 ** 3
// Samples and the queue share this clock, so every sample counts as fresh.
const NOW = 1_000_000
const now = () => NOW

/** A memory governor whose samples the test writes by hand. */
function fakeGovernor() {
  const listeners = new Set<(state: ZotzMemoryGovernorState) => void>()
  let state: ZotzMemoryGovernorState | null = null
  return {
    setWaitingDemand: () => {},
    subscribe: (listener: (state: ZotzMemoryGovernorState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getState: () => state,
    getLedger: () => ({}),
    wake: () => {},
    sample(availableGb: number, runningAgents: number, paneKeys: readonly string[] = []) {
      state = {
        totalBytes: 16 * GB,
        availableBytes: availableGb * GB,
        pressure: availableGb < 3.5 ? 'elevated' : 'ok',
        // A 16 GB machine: 2 agents at a time, 2.4 GB always free.
        limits: computeZotzMemoryGovernorDefaults(16 * GB),
        agents: Array.from({ length: runningAgents }, (_, index) => ({
          paneKey: paneKeys[index] ?? `running-${index}`,
          agent: 'claude' as const,
          state: 'working' as const,
          worktreeId: null,
          bytes: 1 * GB,
          peakBytes: 1 * GB,
          startedAt: 0
        })),
        finished: [],
        sampledAt: NOW
      }
      for (const listener of listeners) {
        listener(state)
      }
    }
  }
}

describe('ZotzAgentLaunchQueue', () => {
  it('holds launches until memory and a free slot let them in, manual first', async () => {
    const governor = fakeGovernor()
    const queue = new ZotzAgentLaunchQueue(governor, now)
    const started: string[] = []
    const launch = (paneKey: string, priority: 'manual' | 'automation') =>
      queue.admit({ agent: 'codex', priority, paneKey, label: paneKey }).then(() => {
        started.push(paneKey)
      })

    const nightly = launch('nightly', 'automation')
    const mine = launch('mine', 'manual')
    // A remounted pane spawns again: it joins its entry instead of queueing twice.
    const remount = queue.admit({
      agent: 'codex',
      priority: 'manual',
      paneKey: 'mine',
      label: 'mine'
    })
    governor.sample(3, 0)
    await Promise.resolve()
    expect(started).toEqual([])
    expect(queue.list().map((task) => [task.id, task.position])).toEqual([
      ['mine', 1],
      ['nightly', 2]
    ])

    // 9 GB free: room for one 2.5 GB agent next to the one already running.
    governor.sample(9, 1)
    await Promise.all([mine, remount])
    expect(started).toEqual(['mine'])
    expect(queue.list().map((task) => task.id)).toEqual(['nightly'])

    governor.sample(12, 0)
    await nightly
    expect(started).toEqual(['mine', 'nightly'])
  })

  it('lets the user cancel a queued launch or start it anyway', async () => {
    const governor = fakeGovernor()
    const queue = new ZotzAgentLaunchQueue(governor, now)
    governor.sample(3, 0)
    const canceled = queue.admit({ agent: 'claude', priority: 'remote', paneKey: 'a', label: 'a' })
    const forced = queue.admit({ agent: 'claude', priority: 'remote', paneKey: 'b', label: 'b' })
    queue.cancel('a')
    queue.forceStart('b')
    await expect(canceled).resolves.toBe('canceled')
    await expect(forced).resolves.toBe('admitted')
    expect(queue.list()).toEqual([])
  })

  it('keeps a canceled pane canceled when it respawns, until the mark is dismissed', async () => {
    const governor = fakeGovernor()
    const queue = new ZotzAgentLaunchQueue(governor, now)
    governor.sample(3, 0)
    void queue.admit({ agent: 'claude', priority: 'manual', paneKey: 'a', label: 'wt-1' })
    queue.cancel('a')

    // The pane asks again with the same key: it must not rejoin the backlog.
    await expect(
      queue.admit({ agent: 'claude', priority: 'manual', paneKey: 'a', label: 'wt-1' })
    ).resolves.toBe('canceled')
    expect(queue.list()).toEqual([])
    expect(queue.listCanceled().map((entry) => [entry.id, entry.label])).toEqual([['a', 'wt-1']])

    queue.dismissCanceled('a')
    expect(queue.listCanceled()).toEqual([])
  })

  it('forgets a launch whose pane closed without marking it canceled', async () => {
    const governor = fakeGovernor()
    const queue = new ZotzAgentLaunchQueue(governor, now)
    governor.sample(3, 0)
    const closing = new AbortController()
    const launch = queue.admit({
      agent: 'claude',
      priority: 'manual',
      paneKey: 'a',
      label: 'wt-1',
      signal: closing.signal
    })
    closing.abort()
    await expect(launch).resolves.toBe('canceled')
    expect(queue.listCanceled()).toEqual([])
  })

  it('starts everything waiting when the queue is turned off and holds nothing new', async () => {
    const governor = fakeGovernor()
    const queue = new ZotzAgentLaunchQueue(governor, now)
    governor.sample(3, 0)
    const waiting = queue.admit({ agent: 'codex', priority: 'manual', paneKey: 'a', label: 'a' })
    queue.setEnabled(false)
    await expect(waiting).resolves.toBe('admitted')
    await expect(
      queue.admit({ agent: 'codex', priority: 'manual', paneKey: 'b', label: 'b' })
    ).resolves.toBe('admitted')
    expect(queue.list()).toEqual([])
  })

  it('stops reserving for an admitted agent once a sample measures it', async () => {
    const governor = fakeGovernor()
    const queue = new ZotzAgentLaunchQueue(governor, now)
    const started: string[] = []
    const launch = (paneKey: string) =>
      queue.admit({ agent: 'codex', priority: 'manual', paneKey, label: paneKey }).then(() => {
        started.push(paneKey)
      })

    // 16 GB: two agents at a time; one already runs, so only the first launch fits.
    governor.sample(12, 1)
    const first = launch('first')
    void launch('second')
    await first
    expect(started).toEqual(['first'])

    // The next sample measures "first"; its reservation must not take the last slot twice.
    governor.sample(11, 2, ['running-0', 'first'])
    await Promise.resolve()
    expect(started).toEqual(['first'])

    // "running-0" ends: the slot frees at once, without waiting out the reservation.
    governor.sample(12, 1, ['first'])
    await Promise.resolve()
    expect(started).toEqual(['first', 'second'])
  })
})
