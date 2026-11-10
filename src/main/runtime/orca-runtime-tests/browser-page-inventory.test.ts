import { EventEmitter } from 'node:events'
import type { AppState } from '../../../renderer/src/store/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './orca-runtime-test-lifecycle.spec'
import { createRuntime, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'
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
function fixture() {
  const runtime = createRuntime()
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
  runtime.setAgentBrowserBridge(bridge as never)
  electronMocks.webContents.fromId.mockReturnValue({ isDestroyed: () => false })
  const sync = (snapshots = publication(), extra: Partial<RuntimeSyncWindowGraph> = {}) =>
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: snapshots, ...extra })
  const list = () => runtime.browserTabList({ worktree: `id:${TEST_WORKTREE_ID}` })
  return { runtime, live, titles, bridge, sync, list }
}
afterEach(() => vi.useRealTimers())

describe('accepted saved browser page inventory', () => {
  it('lists reclaimed siblings and lazily switches only the requested saved identity', async () => {
    const { runtime, live, bridge, sync, list } = fixture()
    sync()
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
    const activated: unknown[] = []
    const ipc = new EventEmitter()
    const contents = Object.assign(new EventEmitter(), {
      ipc,
      send: (channel: string, payload: { browserPageId: string; worktreeId: string }) => {
        if (channel === 'browser:activateView') {
          activated.push(payload)
          live.set(payload.browserPageId, 31)
          queueMicrotask(() =>
            resolveTabRegistrationWaiters(payload.browserPageId, TEST_WORKTREE_ID)
          )
        }
      }
    })
    const window = { isDestroyed: () => false, webContents: contents }
    electronMocks.BrowserWindow.fromId.mockReturnValue(window)
    watchBrowserMainWindowReadiness(window as never)
    ipc.emit('browser:tabRequestsReady')
    expect(await runtime.browserTabSwitch({ page: 'A' })).toMatchObject({
      browserPageId: 'A',
      switched: 1
    })
    expect(activated).toEqual([{ worktreeId: TEST_WORKTREE_ID, browserPageId: 'A' }])
    expect([...live.keys()]).toEqual(['C', 'A'])
    expect(bridge.tabSwitch).toHaveBeenCalledWith(undefined, TEST_WORKTREE_ID, 'A')
    await expect(runtime.browserTabSwitch({ page: 'arbitrary' })).rejects.toThrow('out of range')
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
    const terminalState = {
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [{ id: 'terminal', title: 'Before', customTitle: null, ptyId: null }]
      },
      terminalLayoutsByTabId: {
        terminal: {
          root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
          activeLeafId: '11111111-1111-4111-8111-111111111111',
          expandedLeafId: null
        }
      }
    } as Partial<AppState>
    sync(publication(undefined, undefined, terminalState), { tabs, leaves })
    await vi.advanceTimersByTimeAsync(100)
    const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
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
    const { sync, list } = fixture()
    const original = publication()
    sync(original)
    sync([
      {
        ...original[0]!,
        snapshotVersion: original[0]!.snapshotVersion + 1,
        browserPageInventory: []
      }
    ])
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['C'])
    sync([
      {
        ...original[0]!,
        snapshotVersion: original[0]!.snapshotVersion + 2,
        browserPageInventory: undefined
      }
    ])
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['C'])
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
      { ...workspace, activePageId: 'doc' }
    )
    sync(snapshots)
    expect((await list()).tabs.map((tab) => tab.browserPageId)).toEqual(['A', 'C'])
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })
})
