import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

it('preserves renderer browser ownership across headless reconciliation and close', async () => {
  const closeSessionTab = vi.fn()
  const closeTab = vi.fn().mockResolvedValue(undefined)
  const runtime = new OrcaRuntimeService(store)
  runtime.setOffscreenBrowserBackend({ closeTab } as never)
  const forgetTabs = vi.spyOn(runtime['clientSessionTabSelections'], 'forgetTabs')
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    closeSessionTab,
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'browser-unified-1',
        activeTabType: 'browser',
        tabs: [
          {
            type: 'browser',
            id: 'browser-unified-1',
            title: 'Browser',
            browserWorkspaceId: 'browser-workspace-1',
            browserPageId: 'browser-page-1',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ]
      }
    ]
  })

  await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')
  expect(closeSessionTab).toHaveBeenCalledWith('browser-unified-1', TEST_WORKTREE_ID)
  expect(forgetTabs).toHaveBeenCalledWith(TEST_WORKTREE_ID, ['browser-unified-1'])
  expect(closeTab).not.toHaveBeenCalled()

  const rendererSnapshot = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!
  const headlessTab = {
    type: 'browser',
    id: 'headless-page-1',
    title: 'Headless Browser',
    browserWorkspaceId: 'headless-page-1',
    browserPageId: 'headless-page-1',
    url: 'https://headless.example/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  } satisfies RuntimeMobileSessionSnapshotTab
  const mergedSnapshot: RuntimeMobileSessionTabsSnapshot = {
    ...rendererSnapshot,
    // Why: current getMerged keeps the renderer publisher epoch unchanged.
    publicationEpoch: rendererSnapshot.publicationEpoch,
    tabs: [...rendererSnapshot.tabs, headlessTab]
  }
  runtime['acceptedRendererMobileSnapshotByWorktree'].set(TEST_WORKTREE_ID, {
    publicationEpoch: 'epoch-1',
    rendererVersion: 1,
    rendererTabCount: rendererSnapshot.tabs.length,
    rendererTabIdentityKeys: new Set(
      rendererSnapshot.tabs.flatMap((tab) => [
        tab.id,
        tab.type === 'browser' ? tab.browserWorkspaceId : tab.id
      ])
    )
  })
  runtime['mobileSessionTabsByWorktree'].set(TEST_WORKTREE_ID, mergedSnapshot)

  expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
    expect.objectContaining({ id: 'browser-unified-1' })
  ])

  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
  const reconciled = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!
  expect(reconciled.publicationEpoch).toBe('epoch-1')
  expect(reconciled.tabs).toEqual([expect.objectContaining({ id: 'browser-unified-1' })])

  runtime['mobileSessionTabsByWorktree'].set(TEST_WORKTREE_ID, mergedSnapshot)
  closeSessionTab.mockClear()
  await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')
  expect(closeSessionTab).toHaveBeenCalledWith('browser-unified-1', TEST_WORKTREE_ID)
  expect(closeTab).not.toHaveBeenCalled()

  closeSessionTab.mockClear()
  await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'headless-page-1')
  expect(closeSessionTab).not.toHaveBeenCalled()
  expect(closeTab).toHaveBeenCalledWith('headless-page-1')

  const afterHeadlessClose = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!
  expect(afterHeadlessClose.publicationEpoch).toBe('epoch-1')
  expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
    expect.objectContaining({ id: 'browser-unified-1' })
  ])

  closeSessionTab.mockClear()
  closeTab.mockClear()
  await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')
  expect(closeSessionTab).toHaveBeenCalledWith('browser-unified-1', TEST_WORKTREE_ID)
  expect(closeTab).not.toHaveBeenCalled()

  runtime.setAgentBrowserBridge({
    tabList: vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'headless-page-1',
          title: 'Headless Browser',
          url: 'https://headless.example/'
        }
      ]
    }))
  } as never)
  const detachedSnapshot = runtime['buildPreservedHeadlessMobileSessionSnapshot']({
    ...afterHeadlessClose,
    publicationEpoch: afterHeadlessClose.publicationEpoch,
    tabs: [...afterHeadlessClose.tabs, headlessTab]
  })!
  runtime['acceptedRendererMobileSnapshotByWorktree'].delete(TEST_WORKTREE_ID)
  runtime['mobileSessionTabsByWorktree'].set(TEST_WORKTREE_ID, detachedSnapshot)
  expect(detachedSnapshot.publicationEpoch).toMatch(/^headless-hydrated:/)

  const preservedAgain = runtime['buildPreservedHeadlessMobileSessionSnapshot'](detachedSnapshot)
  expect(preservedAgain?.publicationEpoch).toBe(detachedSnapshot.publicationEpoch)

  closeSessionTab.mockClear()
  closeTab.mockClear()
  await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'headless-page-1')
  expect(closeSessionTab).not.toHaveBeenCalled()
  expect(closeTab).toHaveBeenCalledWith('headless-page-1')
})

it('still preserves live offscreen pages from a legacy merge-suffix snapshot', () => {
  const runtime = new OrcaRuntimeService(store)
  runtime.setOffscreenBrowserBackend({ closeTab: vi.fn() } as never)
  runtime.setAgentBrowserBridge({
    tabList: () => ({
      tabs: [
        {
          browserPageId: 'headless-page-1',
          title: 'Headless Browser',
          url: 'https://headless.example/'
        }
      ]
    })
  } as never)
  const headlessTab = {
    type: 'browser' as const,
    id: 'headless-page-1',
    title: 'Headless Browser',
    browserWorkspaceId: 'headless-page-1',
    browserPageId: 'headless-page-1',
    url: 'https://headless.example/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'epoch-1:headless-merge:runtime-page',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'headless-page-1',
    activeTabType: 'browser',
    tabs: [headlessTab]
  }
  runtime['acceptedRendererMobileSnapshotByWorktree'].delete(TEST_WORKTREE_ID)
  const preserved = runtime['buildPreservedHeadlessMobileSessionSnapshot'](snapshot)
  expect(preserved?.publicationEpoch).toMatch(/^headless-hydrated:/)
  expect(preserved?.tabs).toEqual([expect.objectContaining({ id: 'headless-page-1' })])
})
