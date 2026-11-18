import { describe, expect, it } from 'vitest'
import { computeZotzMemoryGovernorDefaults } from '../../../shared/zotz/agent-queue/zotz-memory-governor-defaults'
import type { ZotzMemoryGovernorState } from './zotz-memory-governor-service'
import { ZotzAgentLaunchCanceledError, ZotzAgentLaunchQueue } from './zotz-agent-launch-queue'

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
    sample(availableGb: number, runningAgents: number) {
      state = {
        totalBytes: 16 * GB,
        availableBytes: availableGb * GB,
        pressure: availableGb < 3.5 ? 'elevated' : 'ok',
        // A 16 GB machine: 2 agents at a time, 2.4 GB always free.
        limits: computeZotzMemoryGovernorDefaults(16 * GB),
        agents: Array.from({ length: runningAgents }, (_, index) => ({
          paneKey: `running-${index}`,
          agent: 'claude' as const,
          bytes: 1 * GB,
          peakBytes: 1 * GB,
          startedAt: 0
        })),
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
    await expect(canceled).rejects.toBeInstanceOf(ZotzAgentLaunchCanceledError)
    await expect(forced).resolves.toBeUndefined()
    expect(queue.list()).toEqual([])
  })
})
