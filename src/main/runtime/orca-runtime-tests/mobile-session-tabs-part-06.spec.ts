import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  appendBrowserTabOrder,
  collectBrowserGroupAssignment
} from '../orca-runtime-test-mocks.spec'
import type { Tab } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps split sibling headless mobile terminal leaves when a desktop renderer omits them', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:split-siblings',
          snapshotVersion: 1,
          activeGroupId: 'headless-group',
          activeTabId: 'host-tab::pane:2',
          activeTabType: 'terminal',
          tabGroups: [
            {
              id: 'headless-group',
              activeTabId: 'host-tab',
              tabOrder: ['host-tab']
            }
          ],
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab::pane:1',
              parentTabId: 'host-tab',
              leafId: 'pane:1',
              title: 'left',
              isActive: false
            },
            {
              type: 'terminal',
              id: 'host-tab::pane:2',
              parentTabId: 'host-tab',
              leafId: 'pane:2',
              title: 'right',
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty',
          snapshotVersion: 2,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'host-tab::pane:1',
        parentTabId: 'host-tab',
        leafId: 'pane:1'
      }),
      expect.objectContaining({
        type: 'terminal',
        id: 'host-tab::pane:2',
        parentTabId: 'host-tab',
        leafId: 'pane:2'
      })
    ])
    expect(listed.activeTabId).toBe('host-tab::pane:2')
  })

  it('keeps a headless tab-group split alive when a new tab is created', async () => {
    // Regression: drag-to-split-group was client-only and the headless host rejected it, coalescing groups on new-tab; the host must model + persist the split.
    let ptyCounter = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `split-group-pty-${++ptyCounter}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const first = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const second = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })

    const beforeSplit = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(beforeSplit.tabGroups).toHaveLength(1)
    const sourceGroupId = beforeSplit.tabGroups![0]!.id
    const secondHostTabId = second.tabId!

    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: secondHostTabId,
      targetGroupId: sourceGroupId,
      splitDirection: 'right'
    })

    const afterSplit = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterSplit.tabGroups).toHaveLength(2)
    expect(afterSplit.tabGroupLayout).toMatchObject({ type: 'split', direction: 'horizontal' })

    // The actual bug: creating a new tab must NOT collapse the split.
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })

    const afterNewTab = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterNewTab.tabGroups).toHaveLength(2)
    expect(afterNewTab.tabGroupLayout).toMatchObject({ type: 'split' })
    // The split-off group keeps exactly its one tab; the new tab joins the other.
    const splitOffGroup = afterNewTab.tabGroups!.find((group) => group.id !== sourceGroupId)!
    expect(splitOffGroup.tabOrder).toEqual([secondHostTabId])
    expect(first.tabId).toBeTruthy()

    // Regression (#2): reordering one group must not delete the other group.
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'reorder',
      tabId: secondHostTabId,
      targetGroupId: splitOffGroup.id,
      tabOrder: [secondHostTabId]
    })
    const afterReorder = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterReorder.tabGroups).toHaveLength(2)
  })

  it('restores a persisted multi-group split on a cold headless rehydrate', async () => {
    // Regression: hydrate must read back session.tabGroups/tabGroupLayouts, or a server restart coalesces the split into one group.
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId: 'persisted-pty',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Left',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'host-tab-2',
            ptyId: 'persisted-pty-2',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Right',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty' }),
        'host-tab-2': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty-2' })
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-left',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'host-tab',
            tabOrder: ['host-tab']
          },
          {
            id: 'group-right',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'host-tab-2',
            tabOrder: ['host-tab-2']
          }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(rehydrated.tabGroups).toHaveLength(2)
    expect(rehydrated.tabGroupLayout).toMatchObject({ type: 'split', direction: 'horizontal' })
    // Each persisted group keeps its own tab — no coalescing.
    const left = rehydrated.tabGroups!.find((g) => g.id === 'group-left')!
    const right = rehydrated.tabGroups!.find((g) => g.id === 'group-right')!
    expect(left.tabOrder).toEqual(['host-tab'])
    expect(right.tabOrder).toEqual(['host-tab-2'])
  })

  it('persists a headless terminal rename so it survives a cold rehydrate', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'rename-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    // Bind a live pty to the persisted 'host-tab' so rename resolves by handle.
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })

    await expect(runtime.renameTerminal(created.handle, 'My Title')).resolves.toMatchObject({
      title: 'My Title'
    })

    // customTitle must be persisted to the workspace session (not just live pty).
    const persistedTab = getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find(
      (tab) => tab.id === 'host-tab'
    )!
    expect(persistedTab.customTitle).toBe('My Title')

    // A cold rehydrate keeps the renamed title.
    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const renamed = rehydrated.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(renamed?.title).toBe('My Title')
  })

  it('persists a headless pane layout (ratio/expand) so it survives a cold rehydrate', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
        second: { type: 'leaf', leafId: 'leaf-2' },
        ratio: 0.7
      },
      expandedLeafId: null,
      titlesByLeafId: { [HEADLESS_LEAF_ID]: 'Pane A' }
    })

    const persisted = getSession().terminalLayoutsByTabId['host-tab']!
    expect(persisted.root).toMatchObject({ type: 'split', direction: 'vertical', ratio: 0.7 })
    expect(persisted.titlesByLeafId).toMatchObject({ [HEADLESS_LEAF_ID]: 'Pane A' })
    // Host-owned pty bindings must be preserved through the structural update.
    expect(persisted.ptyIdsByLeafId).toMatchObject({ [HEADLESS_LEAF_ID]: 'persisted-pty' })

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = rehydrated.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(surface?.type === 'terminal' && surface.parentLayout?.root).toMatchObject({
      type: 'split',
      ratio: 0.7
    })
  })

  it('persists headless tab color + pin and surfaces them through a cold rehydrate', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      color: '#ff8800',
      isPinned: true
    })

    const persisted = getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find(
      (tab) => tab.id === 'host-tab'
    )!
    expect(persisted.color).toBe('#ff8800')
    expect(persisted.isPinned).toBe(true)

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = rehydrated.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(surface?.type === 'terminal' && surface.color).toBe('#ff8800')
    expect(surface?.type === 'terminal' && surface.isPinned).toBe(true)
  })

  it('persists headless browser tab color + pin and surfaces them through a cold rehydrate', async () => {
    const browserTab: Tab = {
      id: 'browser-page-1',
      entityId: 'browser-page-1',
      groupId: 'group-1',
      worktreeId: TEST_WORKTREE_ID,
      contentType: 'browser',
      label: 'Live Browser',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: 2,
      isPreview: false,
      isPinned: false
    }
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      unifiedTabs: { [TEST_WORKTREE_ID]: [browserTab] },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-1',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'browser-page-1',
            tabOrder: ['browser-page-1']
          }
        ]
      }
    })
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })
    runtime.setAgentBrowserBridge({
      tabList: vi.fn(() => ({
        tabs: [
          {
            browserPageId: 'browser-page-1',
            index: 0,
            url: 'https://example.com/',
            title: 'Live Browser',
            active: true
          }
        ]
      }))
    } as never)

    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'browser-page-1',
      color: '#3b82f6',
      isPinned: true
    })

    const persisted = getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.find(
      (tab) => tab.id === 'browser-page-1'
    )
    expect(persisted?.color).toBe('#3b82f6')
    expect(persisted?.isPinned).toBe(true)

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = rehydrated.tabs.find(
      (tab) => tab.type === 'browser' && tab.id === 'browser-page-1'
    )
    expect(surface?.type === 'browser' && surface.color).toBe('#3b82f6')
    expect(surface?.type === 'browser' && surface.isPinned).toBe(true)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'browser-page-1',
      color: null,
      isPinned: false
    })

    const cleared = getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.find(
      (tab) => tab.id === 'browser-page-1'
    )
    expect(cleared?.color).toBeNull()
    expect(cleared?.isPinned).toBe(false)

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydratedCleared = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const clearedSurface = rehydratedCleared.tabs.find(
      (tab) => tab.type === 'browser' && tab.id === 'browser-page-1'
    )
    expect(clearedSurface?.type === 'browser' && clearedSurface.color).toBeNull()
    expect(clearedSurface?.type === 'browser' && clearedSurface.isPinned).toBe(false)
  })

  it('persists headless tab viewMode and surfaces it through a cold rehydrate', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })

    const persisted = getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find(
      (tab) => tab.id === 'host-tab'
    )!
    expect(persisted.viewMode).toBe('chat')

    const live = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const liveSurface = live.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(liveSurface?.type === 'terminal' && liveSurface.viewMode).toBe('chat')

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = rehydrated.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(surface?.type === 'terminal' && surface.viewMode).toBe('chat')
  })

  it('still persists tab props in serve mode after syncWindowGraph(0) (gate does not fire)', async () => {
    // Why: serve's syncWindowGraph(0,...) sets authoritativeWindowId=0, but BrowserWindow.fromId(0) is null, so the renderer-authoritative gate must not fire.
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      isPinned: true
    })

    expect(
      getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find((tab) => tab.id === 'host-tab')!.isPinned
    ).toBe(true)
  })

  it('moves a headless tab into an existing group without renderer_unavailable', async () => {
    let ptyCounter = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `move-group-pty-${++ptyCounter}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const second = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const sourceGroupId = before.tabGroups![0]!.id
    const secondHostTabId = second.tabId!

    // Split into 2 groups, then move the tab back into the source group.
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: secondHostTabId,
      targetGroupId: sourceGroupId,
      splitDirection: 'right'
    })
    const split = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(split.tabGroups).toHaveLength(2)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'move-to-group',
        tabId: secondHostTabId,
        targetGroupId: sourceGroupId
      })
    ).resolves.toEqual({ moved: true })

    const merged = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    // Moving the only tab back collapses the split to a single group.
    expect(merged.tabGroups).toHaveLength(1)
    expect(merged.tabGroups![0]!.tabOrder).toContain(secondHostTabId)
  })

  it('creates a new headless terminal in the targeted split group, not the active one', async () => {
    // Regression: a per-group "+" passes targetGroupId, but the headless create ignored it and funneled every new tab into the active group.
    let ptyCounter = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `target-group-pty-${++ptyCounter}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    // Why: createMobileSessionTerminal asserts the graph is ready; serve marks it ready via syncWindowGraph(0,...) (windowId 0 ≠ a real renderer).
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const second = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const leftGroupId = before.tabGroups![0]!.id

    // Split the 2nd tab into a new right group; the new group becomes active.
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: second.tabId!,
      targetGroupId: leftGroupId,
      splitDirection: 'right'
    })
    const split = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(split.tabGroups).toHaveLength(2)
    const rightGroupId = split.tabGroups!.find((g) => g.id !== leftGroupId)!.id

    // Create a terminal targeting the LEFT (now non-active) group.
    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      targetGroupId: leftGroupId,
      activate: true
    })

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const left = after.tabGroups!.find((g) => g.id === leftGroupId)!
    const right = after.tabGroups!.find((g) => g.id === rightGroupId)!
    expect(left.tabOrder).toHaveLength(2) // original + the targeted create
    expect(right.tabOrder).toHaveLength(1) // unchanged
  })

  it('appendBrowserTabOrder keeps a browser in its group across rebuilds (durability)', () => {
    const groups = [
      { id: 'left', activeTabId: 'web-terminal-a', tabOrder: ['web-terminal-a'] },
      { id: 'right', activeTabId: 'web-terminal-b', tabOrder: ['web-terminal-b'] }
    ]

    // First create: a new browser targeted at the RIGHT group lands there.
    const afterCreate = appendBrowserTabOrder(groups, ['browser-1'], {
      tabId: 'browser-1',
      groupId: 'right'
    })
    expect(afterCreate.find((g) => g.id === 'right')!.tabOrder).toContain('browser-1')
    expect(afterCreate.find((g) => g.id === 'left')!.tabOrder).not.toContain('browser-1')

    // Rebuild: the terminal distributor drops the browser id, so appendBrowserTabOrder must restore it to its prior group, not group[0].
    const rebuiltGroups = [
      { id: 'left', activeTabId: 'web-terminal-a', tabOrder: ['web-terminal-a'] },
      { id: 'right', activeTabId: 'web-terminal-b', tabOrder: ['web-terminal-b'] }
    ]
    const priorAssignment = collectBrowserGroupAssignment(afterCreate, ['browser-1'])
    const afterRebuild = appendBrowserTabOrder(
      rebuiltGroups,
      ['browser-1'],
      undefined,
      priorAssignment
    )
    expect(afterRebuild.find((g) => g.id === 'right')!.tabOrder).toContain('browser-1')
    expect(afterRebuild.find((g) => g.id === 'left')!.tabOrder).not.toContain('browser-1')
  })

  it('keeps preserved headless mobile session publication epochs idempotent', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:stable-epoch',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'host-tab::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab::pane:1',
              parentTabId: 'host-tab',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const firstMerge = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const secondMerge = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(secondMerge.publicationEpoch).toBe(firstMerge.publicationEpoch)
    expect(secondMerge.publicationEpoch).toBe('headless:stable-epoch')
  })

  it('keeps the graph ready when a mobile snapshot references a removed folder workspace', () => {
    const runtime = new OrcaRuntimeService({
      ...store,
      getFolderWorkspaces: () => []
    } as never)

    expect(() =>
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: 'folder:removed-folder',
            publicationEpoch: 'stale-folder-publication',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
    ).not.toThrow()
    expect(runtime.getStatus().graphStatus).toBe('ready')
  })

  it('scans ordinary persisted sessions once instead of once per graph workspace', () => {
    const tabsByWorktree = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `${TEST_REPO_ID}::/tmp/worktree-${index}`,
        [{ id: `tab-${index}`, ptyId: `${TEST_REPO_ID}::/tmp/worktree-${index}@@pty` }]
      ])
    )
    const session = { tabsByWorktree, terminalLayoutsByTabId: {} }
    const getWorkspaceSession = vi.fn(() => session)
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorkspaceSession,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: Object.keys(tabsByWorktree).map((worktree) => ({
        worktree,
        publicationEpoch: 'large-profile',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }))
    })

    expect(getWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(runtime.getStatus().graphStatus).toBe('ready')
  })

  it('hydrates runtime-owned candidates from one host-session read', () => {
    const tabsByWorktree = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `${TEST_REPO_ID}::/tmp/runtime-worktree-${index}`,
        [{ id: `runtime-tab-${index}`, ptyId: `serve-runtime-${index}` }]
      ])
    )
    const session = { tabsByWorktree, terminalLayoutsByTabId: {} }
    const getWorkspaceSession = vi.fn(() => session)
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorkspaceSession,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

    expect(getWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(runtime.getStatus().graphStatus).toBe('ready')
  })
})
