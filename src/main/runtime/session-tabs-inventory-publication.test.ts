import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

type InventoryInternals = {
  sessionTabsInventoryWaiters: Set<() => void>
}

function createInventoryRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  return runtime
}

async function waitForInventoryWaiter(runtime: OrcaRuntimeService): Promise<void> {
  const internals = runtime as unknown as InventoryInternals
  for (let index = 0; index < 20 && internals.sessionTabsInventoryWaiters.size === 0; index += 1) {
    await Promise.resolve()
  }
  expect(internals.sessionTabsInventoryWaiters.size).toBe(1)
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    await Promise.resolve()
    expect(settled).toBe(false)

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    await expect(pending).resolves.toEqual({ snapshots: [], authoritative: true })
    expect(collect).toHaveBeenCalledTimes(2)
  })

  it('treats an initial headless graph as an authoritative empty publication', async () => {
    const runtime = createInventoryRuntime()
    const pending = runtime.listAllMobileSessionTabsInventory()
    await waitForInventoryWaiter(runtime)

    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(pending).resolves.toEqual({ snapshots: [], authoritative: true })
  })

  it('returns a non-empty headed publication normally', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    const pending = runtime.listAllMobileSessionTabsInventory()
    await waitForInventoryWaiter(runtime)

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: 'repo::/worktree',
          publicationEpoch: 'renderer-epoch',
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
      snapshots: [{ worktree: 'repo::/worktree', publicationEpoch: 'renderer-epoch' }]
    })
  })

  it('uses one inventory scan when the current publication is already authoritative', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const collect = vi.spyOn(
      runtime as unknown as { collectAllMobileSessionTabs: () => Promise<unknown> },
      'collectAllMobileSessionTabs'
    )

    await expect(runtime.listAllMobileSessionTabsInventory()).resolves.toEqual({
      snapshots: [],
      authoritative: true
    })

    expect(collect).toHaveBeenCalledOnce()
  })

  it('retries publication churn until one inventory observes a stable epoch', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const inventory = {
      snapshots: [],
      ptyInventory: {
        livePtyIds: new Set<string>(),
        allLivePtyIds: new Set<string>(),
        terminalIdentityByPtyId: new Map(),
        queriedHostIds: new Set(['local'])
      }
    }
    let collections = 0
    vi.spyOn(
      runtime as unknown as { collectAllMobileSessionTabs: () => Promise<unknown> },
      'collectAllMobileSessionTabs'
    ).mockImplementation(async () => {
      collections += 1
      if (collections <= 3) {
        expect(runtime.markRendererReloading(1)).not.toBeNull()
        runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
      }
      return inventory
    })

    await expect(runtime.listAllMobileSessionTabsInventory()).resolves.toEqual({
      snapshots: [],
      authoritative: true
    })
    expect(collections).toBe(4)
  })

  it('coalesces targeted and all-host PTY refreshes behind one aggregate census', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const emptyInventory = {
      livePtyIds: new Set<string>(),
      allLivePtyIds: new Set<string>(),
      terminalIdentityByPtyId: new Map(),
      queriedHostIds: new Set(['local'])
    }
    let resolveRefresh: ((inventory: typeof emptyInventory) => void) | undefined
    const internals = runtime as unknown as {
      refreshMobileSessionPtyInventory: (targetWorktreeId?: string | null) => Promise<unknown>
      performMobileSessionPtyRecordsRefresh: (targetWorktreeId: string | null) => Promise<unknown>
    }
    const perform = vi.spyOn(internals, 'performMobileSessionPtyRecordsRefresh').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )

    const allHosts = runtime.listAllMobileSessionTabsInventory()
    await Promise.resolve()
    const targeted = internals.refreshMobileSessionPtyInventory('repo::/target')
    await Promise.resolve()

    expect(perform).toHaveBeenCalledOnce()
    resolveRefresh?.(emptyInventory)

    await targeted
    await expect(allHosts).resolves.toEqual({ snapshots: [], authoritative: true })
  })

  it('retries once and serves an unlabeled scan when the PTY census is unavailable', async () => {
    const runtime = new OrcaRuntimeService()
    const collect = vi.spyOn(
      runtime as unknown as { collectAllMobileSessionTabs: () => Promise<unknown> },
      'collectAllMobileSessionTabs'
    )
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

    await expect(runtime.listAllMobileSessionTabsInventory()).resolves.toEqual({ snapshots: [] })
    // Why: the retry gives daemon-backed tabs a post-race restore chance.
    expect(collect).toHaveBeenCalledTimes(2)
  })

  it('serves an unlabeled scan when an execution host is omitted from the census', async () => {
    const runtime = createInventoryRuntime()
    vi.spyOn(
      runtime as unknown as {
        listKnownExecutionHostIds: () => Set<string>
      },
      'listKnownExecutionHostIds'
    ).mockReturnValue(new Set(['local', 'ssh:box-1']))
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

    await expect(runtime.listAllMobileSessionTabsInventory()).resolves.toEqual({ snapshots: [] })
  })

  it('restores a renderer-owned PTY discovered by the authoritative inventory refresh', async () => {
    const runtime = createInventoryRuntime()
    const ptyId = 'pty-survived-host-relaunch'
    const worktreeId = 'repo::/survived'
    const tabId = '11111111-1111-4111-8111-111111111111'
    const leafId = '22222222-2222-4222-8222-222222222222'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    ;(
      runtime as unknown as {
        pairedRendererSessionOwnedPtyIds: Set<string>
      }
    ).pairedRendererSessionOwnedPtyIds.add(ptyId)
    vi.spyOn(
      runtime as unknown as { refreshMobileSessionPtyInventory: () => Promise<unknown> },
      'refreshMobileSessionPtyInventory'
    ).mockImplementation(async () => {
      runtime.registerPty(ptyId, worktreeId, null, {
        tabId,
        leafId,
        incarnationId: 'incarnation-survived-host-relaunch'
      })
      return {
        livePtyIds: new Set([ptyId]),
        allLivePtyIds: new Set([ptyId]),
        terminalIdentityByPtyId: new Map(),
        queriedHostIds: new Set(['local'])
      }
    })

    const result = await runtime.listAllMobileSessionTabsInventory()

    expect(result).toMatchObject({
      authoritative: true,
      snapshots: [
        {
          worktree: worktreeId,
          tabs: [
            expect.objectContaining({
              type: 'terminal',
              parentTabId: tabId,
              leafId,
              ptyId
            })
          ]
        }
      ]
    })
  })

  it('requires the current headed renderer generation to publish', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    await Promise.resolve()
    expect(settled).toBe(false)

    runtime.syncWindowGraph(1, {
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

    const incomplete = runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [],
      unchangedMobileSessionWorktrees: [worktree]
    })
    expect(incomplete.mobileSessionResyncWorktrees).toEqual([worktree])
    const pending = runtime.listAllMobileSessionTabsInventory()
    await waitForInventoryWaiter(runtime)

    runtime.syncWindowGraph(1, {
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
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
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
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
    expect((runtime as unknown as InventoryInternals).sessionTabsInventoryWaiters.size).toBe(0)
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
    expect(
      (runtime as unknown as { sessionTabsInventoryPublicationEpoch: number | null })
        .sessionTabsInventoryPublicationEpoch
    ).toBeNull()

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    await expect(pending).resolves.toEqual({ snapshots: [], authoritative: true })
  })

  it('reports no authoritative support behind the e2e disable override', () => {
    vi.stubEnv('ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY', '1')
    try {
      expect(createInventoryRuntime().supportsAuthoritativeSessionTabsInventory()).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
