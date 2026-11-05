import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getSessionTabsInventoryPublication } from './session-tabs/session-tabs-inventory-test-fixture'

function createInventoryRuntime(
  runtimeStore: ConstructorParameters<typeof OrcaRuntimeService>[0] = null
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  return runtime
}

async function waitForInventoryWaiter(runtime: OrcaRuntimeService): Promise<void> {
  const publication = getSessionTabsInventoryPublication(runtime)
  await vi.waitFor(() => expect(publication.pendingWaiterCount).toBe(1))
}

describe('authoritative session tab inventory publication', () => {
  it('primes daemon-backed inventory but withholds headed results until renderer publication', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    const collect = vi.spyOn(
      runtime as unknown as { collectAllMobileSessionTabs: () => Promise<unknown> },
      'collectAllMobileSessionTabs'
    )
    let settled = false

    const pending = runtime.listAllMobileSessionTabsInventory().then((result) => {
      settled = true
      return result
    })
    await waitForInventoryWaiter(runtime)

    expect(collect).toHaveBeenCalledTimes(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    await Promise.resolve()
    expect(settled).toBe(false)

    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    await expect(pending).resolves.toEqual({ snapshots: [], authoritative: true })
    expect(collect).toHaveBeenCalledTimes(2)
  })

  it('treats an initial headless graph as an authoritative empty publication', async () => {
    const runtime = createInventoryRuntime()
    const pending = runtime.listAllMobileSessionTabsInventory()
    await waitForInventoryWaiter(runtime)

    await runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(pending).resolves.toEqual({ snapshots: [], authoritative: true })
  })

  it('retries once and serves an unlabeled scan when the PTY census is unavailable', async () => {
    const runtime = new OrcaRuntimeService()
    const collect = vi.spyOn(
      runtime as unknown as { collectAllMobileSessionTabs: () => Promise<unknown> },
      'collectAllMobileSessionTabs'
    )
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

    await expect(runtime.listAllMobileSessionTabsInventory()).resolves.toEqual({ snapshots: [] })
    // Why: the retry gives daemon-backed tabs a post-race restore chance.
    expect(collect).toHaveBeenCalledTimes(2)
  })

  it('requires the current headed renderer generation to publish', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: []
    })
    runtime.markRendererReloading(1)
    let settled = false

    const pending = runtime.listAllMobileSessionTabsInventory().then((result) => {
      settled = true
      return result
    })
    await waitForInventoryWaiter(runtime)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    await Promise.resolve()
    expect(settled).toBe(false)

    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: 'repo::/restored',
          publicationEpoch: 'renderer-reloaded',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    await expect(pending).resolves.toMatchObject({
      authoritative: true,
      snapshots: [{ worktree: 'repo::/restored', publicationEpoch: 'renderer-reloaded' }]
    })
  })

  it('withholds authority while the renderer owes a requested worktree resync', async () => {
    const runtime = createInventoryRuntime()
    const worktree = 'repo::/resync'
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

    const incomplete = await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [],
      unchangedMobileSessionWorktrees: [worktree]
    })
    expect(incomplete.mobileSessionResyncWorktrees).toEqual([worktree])
    const pending = runtime.listAllMobileSessionTabsInventory()
    await waitForInventoryWaiter(runtime)

    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree,
          publicationEpoch: 'renderer-resynced',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    await expect(pending).resolves.toMatchObject({
      authoritative: true,
      snapshots: [{ worktree, publicationEpoch: 'renderer-resynced' }]
    })
  })

  it('restores publication authority when a renderer reload is cancelled', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const fence = runtime.markRendererReloading(1)
    if (!fence) {
      throw new Error('expected renderer reload fence')
    }
    const pending = runtime.listAllMobileSessionTabsInventory()
    await waitForInventoryWaiter(runtime)

    expect(runtime.markRendererReloadCancelled(1, fence)).toBe(true)

    await expect(pending).resolves.toEqual({ snapshots: [], authoritative: true })
  })

  it('restores authoritative headless publication after a failed desktop promotion', async () => {
    const runtime = createInventoryRuntime()
    await runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    runtime.attachWindow(1)
    const pending = runtime.listAllMobileSessionTabsInventory()
    await waitForInventoryWaiter(runtime)

    runtime.markGraphReloadFailed(1, 'renderer-process-gone')

    await expect(pending).resolves.toEqual({ snapshots: [], authoritative: true })
  })

  it('removes a publication waiter when the request is cancelled', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    const controller = new AbortController()
    const pending = runtime.listAllMobileSessionTabsInventory(undefined, controller.signal)
    await waitForInventoryWaiter(runtime)

    controller.abort()

    await expect(pending).rejects.toThrow('client_disconnected')
    expect(getSessionTabsInventoryPublication(runtime).pendingWaiterCount).toBe(0)
  })

  it('does not scan when the inventory request is already cancelled', async () => {
    const runtime = createInventoryRuntime()
    const collect = vi.spyOn(
      runtime as unknown as { collectAllMobileSessionTabs: () => Promise<unknown> },
      'collectAllMobileSessionTabs'
    )
    const controller = new AbortController()
    controller.abort()

    await expect(
      runtime.listAllMobileSessionTabsInventory(undefined, controller.signal)
    ).rejects.toThrow('client_disconnected')
    expect(collect).not.toHaveBeenCalled()
  })

  it('does not let a secondary renderer graph publish inventory authority', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    let settled = false

    const pending = runtime.listAllMobileSessionTabsInventory().then((result) => {
      settled = true
      return result
    })
    await waitForInventoryWaiter(runtime)

    expect(() =>
      runtime.syncWindowGraph(2, { tabs: [], leaves: [], mobileSessionTabs: [] })
    ).toThrow('Runtime graph publisher does not match the authoritative window')
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(getSessionTabsInventoryPublication(runtime).epoch).toBeNull()

    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    await expect(pending).resolves.toEqual({ snapshots: [], authoritative: true })
  })
})
