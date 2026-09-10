import { describe, expect, it, vi } from 'vitest'
import {
  SharedExecutionHostResourceCollector,
  type HostResourceSnapshot
} from './maestro-resource-inventory'

const EMPTY_INVENTORY = {
  daemonGenerations: [],
  workerIds: [],
  browserSurfaceIds: [],
  processRootPids: [],
  rendererCount: 0,
  aggregateCpu: 0,
  aggregateMemory: 0
}

function snapshot(workerId: string): HostResourceSnapshot {
  return {
    state: 'normal',
    reason: null,
    collectedAt: 1,
    hostMemoryUsagePercent: 20,
    inventory: { ...EMPTY_INVENTORY, workerIds: [workerId] }
  }
}

describe('SharedExecutionHostResourceCollector', () => {
  it('coalesces visible nodes in the same host and workspace', async () => {
    const collector = new SharedExecutionHostResourceCollector()
    const load = vi.fn(async () => snapshot('worker-a'))
    const scope = { executionHostId: 'host-a', workspaceKey: 'workspace-a', visible: true }

    const [first, second] = await Promise.all([
      collector.collect(scope, load),
      collector.collect(scope, load)
    ])

    expect(load).toHaveBeenCalledTimes(1)
    expect(first.inventory.workerIds).toEqual(['worker-a'])
    expect(second.inventory.workerIds).toEqual(['worker-a'])
  })

  it('never relabels an in-flight workspace response as another workspace', async () => {
    const collector = new SharedExecutionHostResourceCollector()
    let resolveFirst!: (value: HostResourceSnapshot) => void
    const firstLoad = vi.fn(
      async () =>
        await new Promise<HostResourceSnapshot>((resolve) => {
          resolveFirst = resolve
        })
    )
    const first = collector.collect(
      { executionHostId: 'host-a', workspaceKey: 'workspace-a', visible: true },
      firstLoad
    )
    const second = collector.collect(
      { executionHostId: 'host-a', workspaceKey: 'workspace-b', visible: true },
      async () => snapshot('worker-b')
    )
    resolveFirst(snapshot('worker-a'))

    await expect(first).resolves.toMatchObject({
      workspaceKey: 'workspace-a',
      inventory: { workerIds: ['worker-a'] }
    })
    await expect(second).resolves.toMatchObject({
      workspaceKey: 'workspace-b',
      inventory: { workerIds: ['worker-b'] }
    })
    expect(firstLoad).toHaveBeenCalledTimes(1)
  })

  it('backs off failures and never loads a hidden summary', async () => {
    let now = 10
    const collector = new SharedExecutionHostResourceCollector(() => now)
    const load = vi.fn(async () => {
      throw new Error('unavailable')
    })
    const scope = { executionHostId: 'host-a', workspaceKey: 'workspace-a', visible: true }

    await expect(collector.collect(scope, load)).resolves.toMatchObject({
      state: 'unverifiable'
    })
    await collector.collect(scope, load)
    await collector.collect({ ...scope, visible: false }, load)
    expect(load).toHaveBeenCalledTimes(1)

    now += 1_000
    await collector.collect(scope, load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
