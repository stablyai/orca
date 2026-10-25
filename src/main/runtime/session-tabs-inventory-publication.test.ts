import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getSessionTabsInventoryPublication } from './session-tabs/session-tabs-inventory-test-fixture'
import type { RuntimeStore } from './runtime-store-contract'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import { registerBoundPty } from './bind-first-pane.test-fixture'
import { makeRuntimeStoreWithWorkspaceSession } from './orca-runtime-test-fixtures.spec'

function createInventoryRuntime(
  runtimeStore: ConstructorParameters<typeof OrcaRuntimeService>[0] = null
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  return runtime
}

async function waitForInventoryWaiter(runtime: OrcaRuntimeService): Promise<void> {
  const publication = getSessionTabsInventoryPublication(runtime)
  for (let index = 0; index < 20 && publication.pendingWaiterCount === 0; index += 1) {
    await Promise.resolve()
  }
  expect(publication.pendingWaiterCount).toBe(1)
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

  it('keeps targeted PTY refreshes independent from an aggregate census', async () => {
    const runtime = createInventoryRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const emptyInventory = {
      livePtyIds: new Set<string>(),
      allLivePtyIds: new Set<string>(),
      terminalIdentityByPtyId: new Map(),
      queriedHostIds: new Set(['local'])
    }
    const pendingResolves: ((inventory: typeof emptyInventory) => void)[] = []
    const internals = runtime as unknown as {
      refreshMobileSessionPtyInventory: (targetWorktreeId?: string | null) => Promise<unknown>
      performMobileSessionPtyRecordsRefresh: (targetWorktreeId: string | null) => Promise<unknown>
    }
    const perform = vi.spyOn(internals, 'performMobileSessionPtyRecordsRefresh').mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingResolves.push(resolve)
        })
    )

    const allHosts = runtime.listAllMobileSessionTabsInventory()
    await Promise.resolve()
    const targeted = internals.refreshMobileSessionPtyInventory('repo::/target')
    await Promise.resolve()

    expect(perform).toHaveBeenCalledTimes(2)
    expect(perform).toHaveBeenNthCalledWith(1, null)
    expect(perform).toHaveBeenNthCalledWith(2, 'repo::/target')
    pendingResolves[1]?.(emptyInventory)

    await targeted
    pendingResolves[0]?.(emptyInventory)
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
    // Main binds restored panes through the store's workspace session.
    const runtime = createInventoryRuntime(
      makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession()).runtimeStore
    )
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
      registerBoundPty(runtime, ptyId, worktreeId, null, {
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

describe('workspace-terminal-resume-records characterization', () => {
  type ResumeStore = Pick<
    RuntimeStore,
    'getWorkspaceSession' | 'setWorkspaceSession' | 'runDurableMutation'
  >
  const WORKTREE_ID = 'repo::/workspace'
  const HOST_ID = 'runtime:original-partition'

  function clear(runtime: InstanceType<typeof OrcaRuntimeService>): Promise<void> {
    return runtime['clearWorktreeTerminalResumeRecords'](WORKTREE_ID, HOST_ID, ['closed'])
  }

  describe('workspace terminal resume mutation ownership', () => {
    it('reads the current mutation and rollback stores with their original receivers', async () => {
      const runtime = new OrcaRuntimeService(null)
      let runMutation = (): void => {
        throw new Error('mutation was not reserved')
      }
      let rollback = (): void => {
        throw new Error('rollback was not installed')
      }
      let finish = (): void => {
        throw new Error('mutation was not staged')
      }
      const before: WorkspaceSessionState = {
        ...getDefaultWorkspaceSession(),
        terminalPtyIncarnationsByPaneKey: { 'closed:leaf': 'old', 'other:leaf': 'other' }
      }
      let mutationSession = before
      let rollbackSession = before
      const reservation: ResumeStore = {
        getWorkspaceSession: () => {
          throw new Error('reservation store read')
        },
        setWorkspaceSession: () => {
          throw new Error('reservation store write')
        },
        runDurableMutation<Value>(
          mutate: () => DurableProfileStateMutation<Value>
        ): Promise<Value> {
          expect(this).toBe(reservation)
          const deferred = Promise.withResolvers<Value>()
          runMutation = () => {
            const staged = mutate()
            rollback =
              staged.rollback ??
              (() => {
                throw new Error('rollback absent')
              })
            finish = () => deferred.resolve(staged.value)
          }
          return deferred.promise
        }
      }
      const mutation: ResumeStore = {
        getWorkspaceSession(hostId) {
          expect(this).toBe(mutation)
          expect(hostId).toBe(HOST_ID)
          return mutationSession
        },
        setWorkspaceSession(session, hostId) {
          expect(this).toBe(mutation)
          expect(hostId).toBe(HOST_ID)
          mutationSession = session
        }
      }
      const recovery: ResumeStore = {
        getWorkspaceSession(hostId) {
          expect(this).toBe(recovery)
          expect(hostId).toBe(HOST_ID)
          return rollbackSession
        },
        setWorkspaceSession(session, hostId) {
          expect(this).toBe(recovery)
          expect(hostId).toBe(HOST_ID)
          rollbackSession = session
        }
      }
      let current: ResumeStore | null = reservation
      Object.defineProperty(runtime, 'store', { get: () => current })
      const pending = clear(runtime)
      current = mutation
      runMutation()
      expect(mutationSession.terminalPtyIncarnationsByPaneKey).toEqual({ 'other:leaf': 'other' })
      rollbackSession = {
        ...mutationSession,
        activeWorktreeId: 'another-worktree',
        terminalPtyIncarnationsByPaneKey: {
          ...mutationSession.terminalPtyIncarnationsByPaneKey,
          'new:leaf': 'new'
        }
      }
      current = recovery
      rollback()
      expect(rollbackSession.activeWorktreeId).toBe('another-worktree')
      expect(rollbackSession.terminalPtyIncarnationsByPaneKey).toEqual({
        'closed:leaf': 'old',
        'other:leaf': 'other',
        'new:leaf': 'new'
      })
      finish()
      await pending
    })

    it.each([
      { label: 'null', store: null },
      { label: 'missing reader', store: {} },
      {
        label: 'missing writer',
        store: { getWorkspaceSession: () => getDefaultWorkspaceSession() }
      },
      {
        label: 'missing reservation',
        store: {
          getWorkspaceSession: () => getDefaultWorkspaceSession(),
          setWorkspaceSession: () => {}
        }
      }
    ])('refuses admission with $label', async ({ store }) => {
      const runtime = new OrcaRuntimeService(null)
      Object.defineProperty(runtime, 'store', { get: () => store })
      await expect(clear(runtime)).rejects.toThrow('workspace_session_unavailable')
    })
  })
})
