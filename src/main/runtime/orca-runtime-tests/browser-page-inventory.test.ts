import { EventEmitter } from 'node:events'
import type { AppState } from '../../../renderer/src/store/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './orca-runtime-test-lifecycle.spec'
import {
  createRuntime,
  TEST_WORKTREE_ID,
  TEST_REPO_ID,
  store,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeHeadlessTerminalLayout,
  HEADLESS_LEAF_ID
} from './orca-runtime-test-fixtures.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import { buildMobileSessionTabSnapshots } from '../../../renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots'
import { makeState } from '../../../renderer/src/runtime/sync-runtime-graph/testing/sync-runtime-graph-test-harness'
import { watchBrowserMainWindowReadiness } from '../../browser/guest-lifecycle/browser-main-window-readiness'
import { resolveTabRegistrationWaiters } from '../../ipc/browser/browser-tab-registration-wait'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeSyncWindowGraph
} from '../../../shared/runtime-session-contracts'

const workspace: BrowserWorkspace = {
  id: 'browser-w',
  worktreeId: TEST_WORKTREE_ID,
  activePageId: 'C',
  pageIds: ['A', 'B', 'C'],
  title: 'C',
  url: 'https://c.example/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  faviconUrl: null,
  loadError: null,
  createdAt: 1,
  sessionProfileId: 'default'
}
function page(id: string, updates: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id,
    workspaceId: workspace.id,
    worktreeId: TEST_WORKTREE_ID,
    title: id,
    url: `https://${id.toLowerCase()}.example/`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    loadError: null,
    createdAt: 1,
    ...updates
  }
}
function publication(
  pages = [page('A'), page('B'), page('C')],
  selected = workspace,
  extra: Partial<AppState> = {}
) {
  const state = makeState({
    browserTabsByWorktree: { [TEST_WORKTREE_ID]: [selected] },
    browserPagesByWorkspace: { [workspace.id]: pages },
    activeBrowserTabIdByWorktree: { [TEST_WORKTREE_ID]: workspace.id },
    ...extra
  })
  return buildMobileSessionTabSnapshots(state, false)
}
function fixture(runtime = createRuntime()) {
  runtime.attachWindow(1)
  const live = new Map([['C', 30]])
  const titles = new Map<string, string>()
  const bridge = {
    getRegisteredTabs: () => live,
    tabList: () => ({
      tabs: [...live.keys()].map((id, index) => ({
        browserPageId: id,
        index,
        url: `https://${id.toLowerCase()}.example/`,
        title: titles.get(id) ?? id,
        active: id === 'C',
        loadError: null,
        certificateFailure: null
      }))
    }),
    tabSwitch: vi.fn(async (_index, _worktree, id) => ({ browserPageId: id, switched: 0 }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this bridge implements the list, registration and switch methods reached by the runtime.
  runtime.setAgentBrowserBridge(bridge as never)
  electronMocks.webContents.fromId.mockReturnValue({
    isDestroyed: () => false,
    isLoading: () => false
  })
  vi.spyOn(browserManager, 'getGuestWebContentsId').mockImplementation((id) => live.get(id) ?? null)
  const sync = (snapshots = publication(), extra: Partial<RuntimeSyncWindowGraph> = {}) =>
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: snapshots, ...extra })
  const list = () => runtime.browserTabList({ worktree: `id:${TEST_WORKTREE_ID}` })
  return { runtime, live, titles, bridge, sync, list }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('accepted saved browser page inventory', () => {
  it('lists reclaimed siblings and lazily switches only the requested saved identity', async () => {
    const { runtime, live, bridge, sync, list } = fixture()
    sync()
    const unavailableRenderer = vi.fn(() => {
      throw new Error('renderer unavailable')
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: unavailableRenderer }
    })
    expect(
      (await list()).tabs.map(({ browserPageId, loaded, active, profileId }) => ({
        browserPageId,
        loaded,
        active,
        profileId
      }))
    ).toEqual([
      { browserPageId: 'C', loaded: true, active: true, profileId: 'default' },
      { browserPageId: 'A', loaded: false, active: false, profileId: 'default' },
      { browserPageId: 'B', loaded: false, active: false, profileId: 'default' }
    ])
    expect(unavailableRenderer).not.toHaveBeenCalled()
    const activated: unknown[] = []
    const ipc = new EventEmitter()
    const contents = Object.assign(new EventEmitter(), {
      ipc,
      send: (channel: string, payload: { browserPageId: string; worktreeId: string }) => {
        if (channel === 'browser:activateView') {
          activated.push(payload)
          if (!workspace.pageIds?.includes(payload.browserPageId)) {
            return
          }
          live.set(payload.browserPageId, 31)
          queueMicrotask(() =>
            resolveTabRegistrationWaiters(payload.browserPageId, TEST_WORKTREE_ID)
          )
        }
      }
    })
    const window = { isDestroyed: () => false, webContents: contents }
    electronMocks.BrowserWindow.fromId.mockReturnValue(window)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readiness only needs this window's IPC emitter and send transport.
    watchBrowserMainWindowReadiness(window as never)
    ipc.emit('browser:tabRequestsReady')
    expect(await runtime.browserTabSwitch({ page: 'A' })).toMatchObject({
      browserPageId: 'A',
      switched: 1
    })
    expect(activated).toEqual([{ browserPageId: 'A' }])
    expect([...live.keys()]).toEqual(['C', 'A'])
    expect(bridge.tabSwitch).toHaveBeenCalledWith(undefined, undefined, 'A')
    vi.useFakeTimers()
    const rejected = expect(runtime.browserTabSwitch({ page: 'arbitrary' })).rejects.toThrow(
      'Tab registration timed out'
    )
    await vi.advanceTimersByTimeAsync(8_000)
    await rejected
    expect([...live.keys()]).toEqual(['C', 'A'])
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['C', 'A', 'B'])
    expect(bridge.tabSwitch).not.toHaveBeenCalledWith(undefined, undefined, 'arbitrary')
  })

  it('keeps every worktree selected page ahead of saved siblings in global index switching', async () => {
    const { runtime, live, bridge, sync } = fixture()
    const otherWorktree = `${TEST_REPO_ID}::/tmp/inventory-other`
    const other = {
      ...workspace,
      id: 'browser-x',
      worktreeId: otherWorktree,
      activePageId: 'D',
      pageIds: ['D']
    }
    live.set('D', 40)
    sync(
      publication(undefined, undefined, {
        browserTabsByWorktree: { [TEST_WORKTREE_ID]: [workspace], [otherWorktree]: [other] },
        browserPagesByWorkspace: {
          [workspace.id]: [page('A'), page('B'), page('C')],
          [other.id]: [page('D', { workspaceId: other.id, worktreeId: otherWorktree })]
        }
      })
    )
    expect((await runtime.browserTabList({})).tabs.map((tab) => tab.browserPageId)).toEqual([
      'C',
      'D',
      'A',
      'B'
    ])
    expect(await runtime.browserTabSwitch({ index: 1 })).toMatchObject({
      browserPageId: 'D',
      switched: 1
    })
    expect(bridge.tabSwitch).toHaveBeenCalledWith(undefined, undefined, 'D')
  })

  it('keeps accepted inventory during SSH hydration and retires it with renderer ownership', async () => {
    vi.useFakeTimers()
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId: 'ssh:ssh-1@@remote-pty',
            worktreeId: TEST_WORKTREE_ID,
            title: 'SSH Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({
          [HEADLESS_LEAF_ID]: 'ssh:ssh-1@@remote-pty'
        })
      }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing runtime store fixture supplies the methods used by hydration and catalog reads.
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getWorkspaceSession: () => session
    } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    const { sync, list } = fixture(runtime)
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
    sync()
    await vi.advanceTimersByTimeAsync(100)
    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(before.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ browserPageId: 'C' })])
    )
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    sync([], { unchangedMobileSessionWorktrees: [TEST_WORKTREE_ID] })
    await vi.advanceTimersByTimeAsync(100)
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['C', 'A', 'B'])
    expect(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).toEqual(before)
    expect(events).toEqual([])
    sync([])
    await vi.advanceTimersByTimeAsync(100)
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['C'])
    unsubscribe()
  })

  it('updates the catalog silently, fences stale input, and publishes visible changes once', async () => {
    vi.useFakeTimers()
    const { runtime, sync, list, titles } = fixture()
    sync()
    await vi.advanceTimersByTimeAsync(100)
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(initial.tabs).toHaveLength(1)
    expect(initial).not.toHaveProperty('browserPageInventory')
    const renamed = publication([page('A'), page('B', { title: 'Renamed B' }), page('C')])
    sync(renamed)
    await vi.advanceTimersByTimeAsync(100)
    expect((await list()).tabs.find((tab) => tab.browserPageId === 'B')?.title).toBe('Renamed B')
    expect(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).toEqual(initial)
    expect(events).toEqual([])
    sync(publication([page('A'), page('C')]))
    sync(renamed)
    await vi.advanceTimersByTimeAsync(100)
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['C', 'A'])
    expect(events).toEqual([])
    expect(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).toEqual(initial)
    titles.set('C', 'Visible C')
    sync(publication([page('A'), page('C', { title: 'Visible C' })]))
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toHaveLength(1)
    expect(events[0]).not.toHaveProperty('browserPageInventory')
    expect(events[0]?.tabs[0]?.title).toBe('Visible C')
    expect(events[0]!.snapshotVersion).toBeGreaterThan(initial.snapshotVersion)
    unsubscribe()
  })

  it.each([10, 100])('keeps hidden sibling churn local with %i saved pages', async (count) => {
    vi.useFakeTimers()
    const { runtime, sync, list } = fixture()
    const hidden = Array.from({ length: count }, (_, index) => page(`saved-${index}`))
    sync(publication([...hidden, page('C')]))
    await vi.advanceTimersByTimeAsync(100)
    const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(initial.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ browserPageId: 'C', title: 'C' })])
    )
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    sync(
      publication([...hidden.map((entry) => ({ ...entry, title: 'Updated sibling' })), page('C')])
    )
    await vi.advanceTimersByTimeAsync(100)
    expect((await list()).tabs.filter((entry) => entry.title === 'Updated sibling')).toHaveLength(
      count
    )
    expect(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).toEqual(initial)
    expect(events).toEqual([])
    unsubscribe()
  })

  it('keeps a simultaneous graph-only visible change after an inventory-only acceptance', async () => {
    vi.useFakeTimers()
    const { runtime, sync, list } = fixture()
    const tabs = [
      {
        tabId: 'terminal',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Before',
        activeLeafId: '11111111-1111-4111-8111-111111111111',
        layout: null
      }
    ]
    const leaves = [
      {
        tabId: 'terminal',
        worktreeId: TEST_WORKTREE_ID,
        leafId: '11111111-1111-4111-8111-111111111111',
        paneRuntimeId: 1,
        ptyId: null,
        paneTitle: null
      }
    ]
    const terminalState: Partial<AppState> = {
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'terminal',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Before',
            customTitle: null,
            ptyId: null,
            color: null,
            createdAt: 1,
            sortOrder: 0
          }
        ]
      },
      terminalLayoutsByTabId: {
        terminal: {
          root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
          activeLeafId: '11111111-1111-4111-8111-111111111111',
          expandedLeafId: null
        }
      }
    }
    sync(publication(undefined, undefined, terminalState), { tabs, leaves })
    await vi.advanceTimersByTimeAsync(100)
    const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(initial.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Before' })])
    )
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    sync(
      publication(
        [page('A'), page('B', { title: 'Renamed B' }), page('C')],
        workspace,
        terminalState
      ),
      {
        tabs: [{ ...tabs[0]!, title: 'After' }],
        leaves
      }
    )
    await vi.advanceTimersByTimeAsync(100)
    expect((await list()).tabs.find((tab) => tab.browserPageId === 'B')?.title).toBe('Renamed B')
    expect(events).toHaveLength(1)
    expect(events[0]!.snapshotVersion).toBeGreaterThan(initial.snapshotVersion)
    expect(events[0]!.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'After' })])
    )
    unsubscribe()
  })

  it('replaces complete inventories and keeps the old-producer selected-row fallback', async () => {
    const { runtime, live, sync } = fixture()
    const list = () => runtime.browserTabList({})
    live.delete('C')
    live.set('extra', 40)
    const original = publication()
    sync(original)
    sync([
      {
        ...original[0]!,
        snapshotVersion: original[0]!.snapshotVersion + 1,
        browserPageInventory: []
      }
    ])
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['extra'])
    sync([{ ...original[0]!, snapshotVersion: original[0]!.snapshotVersion + 2 }])
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['C', 'A', 'B', 'extra'])
    sync([
      {
        ...original[0]!,
        snapshotVersion: original[0]!.snapshotVersion + 3,
        browserPageInventory: undefined
      }
    ])
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['C', 'extra'])
    expect(() =>
      sync([
        {
          ...original[0]!,
          browserPageInventory: [
            original[0]!.browserPageInventory![0]!,
            original[0]!.browserPageInventory![0]!
          ]
        }
      ])
    ).toThrow('invalid_browser_page_inventory')
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['C', 'extra'])
  })

  it('publishes ordinary siblings of a selected document without leaking the grant or remote pages', async () => {
    const { runtime, sync, list } = fixture()
    const doc = page('doc', {
      docLocation: {
        kind: 'workspace-doc',
        worktreeId: TEST_WORKTREE_ID,
        filePath: '/tmp/doc.html'
      },
      url: 'about:blank'
    })
    const snapshots = publication(
      [page('A'), doc, page('remote', { browserRuntimeEnvironmentId: 'server' })],
      {
        ...workspace,
        activePageId: 'doc',
        docLocation: doc.docLocation,
        url: doc.url,
        title: doc.title
      }
    )
    expect(snapshots[0]!.tabs).toEqual([])
    expect(snapshots[0]!.browserPageInventory!.map((entry) => entry.browserPageId)).toEqual(['A'])
    sync(snapshots)
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['A', 'C'])
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })
})
