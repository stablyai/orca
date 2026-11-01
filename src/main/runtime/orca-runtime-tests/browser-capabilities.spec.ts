import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  deleteWorktreeHistoryDirMock,
  getBrowserHostLeaseRegistry,
  getRuntimeBrowserPageRegistry
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  store
} from '../orca-runtime-test-fixtures.spec'
import {
  attachClientBrowserHost,
  publishClientHostedPage
} from '../orca-runtime-test-scenario-builders.spec'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

describe('OrcaRuntimeService', () => {
  it('preserves a live client page across headed renderer graph updates and prunes it after retirement', async () => {
    const runtime = createRuntime()
    const pages = getRuntimeBrowserPageRegistry(runtime)
    const placement = {
      kind: 'client' as const,
      browserHostClientId: 'host-a',
      browserHostGeneration: 3,
      pageHostGeneration: 9
    }
    runtime.attachWindow(1)
    const rendererSnapshot = (snapshotVersion: number) => ({
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:client-page-preservation',
      snapshotVersion,
      activeGroupId: 'group-1',
      activeTabId: null,
      activeTabType: null,
      tabGroups: [{ id: 'group-1', activeTabId: null, tabOrder: [] }],
      tabs: []
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(1)]
    })
    pages.publishClientPage({
      browserPageId: 'page-client',
      workspaceId: TEST_WORKTREE_ID,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-a',
      placement,
      url: 'https://remote.internal/',
      loading: false,
      active: true
    })
    runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(2)]
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(3)]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ browserPageId: 'page-client', placement })
    ])

    expect(pages.retirePage('page-client', placement)).toBe(true)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(3)]
    })
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(4)]
    })
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('closes a worktree’s client-hosted browser pages when its metadata is removed (leak fix)', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    const removed = await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)
    const survivor = await publishClientHostedPage(
      runtime,
      host,
      'page-other',
      `${TEST_REPO_ID}::/tmp/other`
    )

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(host.takeCommands()).toEqual([
      expect.objectContaining({
        browserPageId: 'page-removed',
        pageHostGeneration: removed.pageHostGeneration,
        command: {
          type: 'closePage',
          targetAuthority: {
            authorityRuntimeId: runtime.getRuntimeId(),
            authorityEpoch: getBrowserHostLeaseRegistry(runtime).authorityEpoch,
            browserHostClientId: removed.browserHostClientId,
            browserHostGeneration: removed.browserHostGeneration,
            pageHostGeneration: removed.pageHostGeneration
          }
        }
      })
    ])
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-removed')).toBeUndefined()
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-other')?.placement).toEqual(
      survivor
    )
  })

  it('drops a client page record even when its close command cannot be issued', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)
    host.detachDelivery()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-removed')).toBeUndefined()
    expect(runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)).toEqual([])
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not close its client page'),
        expect.objectContaining({
          browserPageId: 'page-removed',
          error: expect.objectContaining({ message: 'browser_host_command_delivery_required' })
        })
      )
    )
    warn.mockRestore()
  })

  it('leaves client-hosted pages alone when another host still owns the same worktree id', async () => {
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' }),
      removeWorktreeMeta: vi.fn()
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const host = attachClientBrowserHost(runtime)
    const placement = await publishClientHostedPage(runtime, host, 'page-kept', TEST_WORKTREE_ID)

    runtime['removeWorktreeMetadataAndHistory'](
      runtimeStore as never,
      TEST_WORKTREE_ID,
      'runtime:env-b'
    )

    expect(host.takeCommands()).toEqual([])
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-kept')?.placement).toEqual(
      placement
    )
  })

  it('preserves bare-id runtime state when removing a different qualified owner', () => {
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' }),
      removeWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      removeWorktreeMetadataAndHistory: (
        runtimeStore: typeof store,
        worktreeId: string,
        hostId: string
      ) => void
    }
    const localSession = { tabs: [{ id: 'local-tab' }] }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, localSession)

    internals.removeWorktreeMetadataAndHistory(
      runtimeStore as typeof store,
      TEST_WORKTREE_ID,
      'runtime:env-b'
    )

    expect(removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: TEST_WORKTREE_ID, hostId: 'runtime:env-b' })
    )
    expect(internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)).toBe(localSession)
  })

  it('preserves bare-id runtime state when removed-host metadata masks another owner', () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, connectionId: 'ssh-1' }
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'ssh:ssh-1' }),
      removeWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      removeWorktreeMetadataAndHistory: (
        runtimeStore: typeof store,
        worktreeId: string,
        hostId: string
      ) => void
    }
    const survivingSession = { tabs: [{ id: 'same-id-local-tab' }] }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, survivingSession)
    deleteWorktreeHistoryDirMock.mockClear()

    internals.removeWorktreeMetadataAndHistory(
      runtimeStore as typeof store,
      TEST_WORKTREE_ID,
      'ssh:ssh-1'
    )

    expect(removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: TEST_WORKTREE_ID, hostId: 'ssh:ssh-1' })
    )
    expect(internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)).toBe(survivingSession)
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })
})
