import { describe, expect, it } from 'vitest'
import './runtime-test-module-registration.spec'
import '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import { getBrowserHostLeaseRegistry } from '../browser-host/leases/browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from '../browser/client-pages/runtime-browser-page-registry'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  store
} from './orca-runtime-test-fixtures.spec'
import {
  attachClientBrowserHost,
  publishClientHostedPage
} from './orca-runtime-test-scenario-builders.spec'
import '../../../shared/worktree/host-qualified-identity'

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
    await runtime.syncWindowGraph(1, {
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

    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(2)]
    })
    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(3)]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ browserPageId: 'page-client', placement })
    ])

    expect(pages.retirePage('page-client', placement)).toBe(true)
    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(3)]
    })
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])

    await runtime.syncWindowGraph(1, {
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
})
