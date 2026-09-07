import { afterEach, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore, SESSION_WORKTREE_ID } from './paired-client-navigation-test-harness'

afterEach(() => vi.useRealTimers())

it('retains renderer-owned browser rows while runtime browser inventory changes', () => {
  vi.useFakeTimers()
  const runtime = new OrcaRuntimeService({
    ...makeStore(),
    getGitHubCache: () => ({ pr: {}, issue: {} })
  } as ConstructorParameters<typeof OrcaRuntimeService>[0])
  const internals = runtime as unknown as {
    offscreenBrowserBackend: unknown
    agentBrowserBridge: unknown
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  }
  const storedTabs = () => internals.mobileSessionTabsByWorktree.get(SESSION_WORKTREE_ID)?.tabs
  const rendererTab = {
    type: 'browser' as const,
    id: 'renderer-tab',
    browserWorkspaceId: 'renderer-workspace',
    browserPageId: 'renderer-page',
    title: 'Retained browser',
    url: 'https://example.test',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: true
  }
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: SESSION_WORKTREE_ID,
        publicationEpoch: 'renderer:retained',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: rendererTab.id,
        activeTabType: 'browser',
        tabs: [rendererTab]
      }
    ]
  })
  vi.advanceTimersByTime(300)
  expect(storedTabs()).toEqual([rendererTab])
  internals.offscreenBrowserBackend = { closeTab: vi.fn() }
  let tabs = [
    {
      browserPageId: 'runtime-page',
      index: 0,
      url: 'https://runtime.test',
      title: 'Runtime',
      active: false
    }
  ]
  internals.agentBrowserBridge = { tabList: () => ({ tabs }), getRegisteredTabs: () => new Map() }
  runtime.notifyMobileSessionTabsChanged(SESSION_WORKTREE_ID)
  expect(storedTabs()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ browserPageId: 'renderer-page' }),
      expect.objectContaining({ browserPageId: 'runtime-page' })
    ])
  )
  tabs = []
  runtime.notifyMobileSessionTabsChanged(SESSION_WORKTREE_ID)
  expect(storedTabs()).toEqual([rendererTab])
})

it('keeps browser reconciliation in the retained renderer publication generation', () => {
  vi.useFakeTimers()
  const runtime = new OrcaRuntimeService({
    ...makeStore(),
    getGitHubCache: () => ({ pr: {}, issue: {} })
  } as ConstructorParameters<typeof OrcaRuntimeService>[0])
  const events: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: SESSION_WORKTREE_ID,
    publicationEpoch: 'renderer:retained-primary',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'terminal::leaf',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'terminal::leaf',
        parentTabId: 'terminal',
        leafId: 'leaf',
        title: 'Terminal',
        isActive: true
      }
    ]
  }
  const publish = (value: RuntimeMobileSessionTabsSnapshot): void => {
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [value] })
    vi.advanceTimersByTime(300)
  }
  publish(snapshot)
  const internals = runtime as unknown as {
    offscreenBrowserBackend: unknown
    agentBrowserBridge: unknown
  }
  internals.offscreenBrowserBackend = { closeTab: vi.fn() }
  internals.agentBrowserBridge = {
    tabList: () => ({
      tabs: [
        {
          browserPageId: 'page-1',
          index: 0,
          url: 'https://example.test',
          title: 'Browser',
          active: false
        }
      ]
    }),
    getRegisteredTabs: () => new Map([['page-1', 100]])
  }
  runtime.notifyMobileSessionTabsChanged(SESSION_WORKTREE_ID)
  expect(events.at(-1)?.tabs.some((tab) => tab.type === 'browser')).toBe(true)
  publish({
    ...snapshot,
    snapshotVersion: 2,
    tabs: snapshot.tabs.map((tab) => ({ ...tab, title: 'Renamed' }))
  })
  expect(events.length).toBeGreaterThanOrEqual(3)
  expect(new Set(events.map((event) => event.publicationEpoch))).toEqual(
    new Set([snapshot.publicationEpoch])
  )
  for (let index = 1; index < events.length; index++) {
    expect(events[index]!.snapshotVersion).toBeGreaterThan(events[index - 1]!.snapshotVersion)
  }
  unsubscribe()
})
