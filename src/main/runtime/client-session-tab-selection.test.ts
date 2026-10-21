import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { PersistedMobileClientTabSelections } from '../../shared/persisted-state-types'
import { ClientSessionTabSelectionStore } from './client-session-tab-selection'
import {
  activateClientSessionTabSelection,
  deriveClientSessionTabSelection,
  projectClientSessionTabSelection
} from './client-session-tab-selection-projection'
import { normalizePersistedMobileClientTabSelections } from './client-session-tab-selection-persistence'

function snapshot(activeTabId = 'terminal-a::leaf-a'): RuntimeMobileSessionTabsResult {
  const tabs = [
    {
      type: 'terminal' as const,
      id: 'terminal-a::leaf-a',
      parentTabId: 'terminal-a',
      leafId: 'leaf-a',
      title: 'A',
      isActive: activeTabId === 'terminal-a::leaf-a',
      status: 'ready' as const,
      terminal: 'term-a'
    },
    {
      type: 'terminal' as const,
      id: 'terminal-a::leaf-b',
      parentTabId: 'terminal-a',
      leafId: 'leaf-b',
      title: 'A split',
      isActive: activeTabId === 'terminal-a::leaf-b',
      status: 'ready' as const,
      terminal: 'term-b'
    },
    {
      type: 'browser' as const,
      id: 'browser-unified',
      browserWorkspaceId: 'browser-workspace',
      browserPageId: 'page-1',
      title: 'Browser',
      url: 'about:blank',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: activeTabId === 'browser-unified'
    }
  ]
  return {
    worktree: 'wt-1',
    publicationEpoch: 'renderer:1',
    snapshotVersion: 1,
    activeGroupId: 'group-left',
    activeTabId,
    activeTabType: activeTabId === 'browser-unified' ? 'browser' : 'terminal',
    tabGroups: [
      { id: 'group-left', activeTabId: 'terminal-a', tabOrder: ['terminal-a'] },
      { id: 'group-right', activeTabId: 'browser-unified', tabOrder: ['browser-unified'] }
    ],
    tabs
  }
}

function browserStrip(
  tabOrder: string[],
  options: { hostActiveTabId?: string; hostRecentTabIds?: string[] } = {}
): RuntimeMobileSessionTabsResult {
  const hostActiveTabId = options.hostActiveTabId ?? tabOrder[0]!
  return {
    worktree: 'wt-1',
    publicationEpoch: 'renderer:1',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: hostActiveTabId,
    activeTabType: 'browser',
    tabGroups: [
      {
        id: 'group',
        activeTabId: hostActiveTabId,
        tabOrder,
        ...(options.hostRecentTabIds ? { recentTabIds: options.hostRecentTabIds } : {})
      }
    ],
    tabs: tabOrder.map((id) => ({
      type: 'browser' as const,
      id,
      browserWorkspaceId: `workspace-${id}`,
      browserPageId: `page-${id}`,
      title: id,
      url: 'about:blank',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: id === hostActiveTabId
    }))
  }
}

function splitBrowserStrips(left: string[], right: string[]): RuntimeMobileSessionTabsResult {
  const leftStrip = browserStrip(left)
  const rightStrip = right.length > 0 ? browserStrip(right) : null
  return {
    ...leftStrip,
    activeGroupId: 'left',
    tabGroups: [
      { ...leftStrip.tabGroups![0]!, id: 'left' },
      ...(rightStrip ? [{ ...rightStrip.tabGroups![0]!, id: 'right' }] : [])
    ],
    tabGroupLayout: rightStrip
      ? {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'left' },
          second: { type: 'leaf', groupId: 'right' }
        }
      : { type: 'leaf', groupId: 'left' },
    tabs: [...leftStrip.tabs, ...(rightStrip?.tabs ?? [])]
  }
}

describe('client session-tab selection', () => {
  it('keeps a client selection when a later host snapshot activates another tab', () => {
    const initial = snapshot()
    const selected = activateClientSessionTabSelection(
      initial,
      deriveClientSessionTabSelection(initial),
      'browser-unified'
    )
    const hostChanged = snapshot('terminal-a::leaf-b')

    const projected = projectClientSessionTabSelection(hostChanged, selected)

    expect(projected.snapshot.activeTabId).toBe('browser-unified')
    expect(projected.snapshot.activeGroupId).toBe('group-right')
    expect(projected.snapshot.tabGroups?.[1]?.activeTabId).toBe('browser-unified')
  })

  it('tracks split-leaf focus while group selection uses the parent tab id', () => {
    const initial = snapshot()
    const selected = activateClientSessionTabSelection(
      initial,
      deriveClientSessionTabSelection(initial),
      'terminal-a::leaf-b'
    )

    const projected = projectClientSessionTabSelection(initial, selected)

    expect(projected.snapshot.activeTabId).toBe('terminal-a::leaf-b')
    expect(projected.snapshot.tabGroups?.[0]?.activeTabId).toBe('terminal-a')
  })

  it('falls back within the selected group when the selected tab disappears', () => {
    const initial = snapshot()
    const selected = activateClientSessionTabSelection(
      initial,
      deriveClientSessionTabSelection(initial),
      'terminal-a::leaf-b'
    )
    const removed = {
      ...initial,
      activeGroupId: 'group-left',
      activeTabId: 'terminal-a::leaf-a',
      activeTabType: 'terminal' as const,
      tabs: initial.tabs.filter((tab) => tab.id !== 'terminal-a::leaf-b')
    }

    const projected = projectClientSessionTabSelection(removed, selected)

    expect(projected.snapshot.activeGroupId).toBe('group-left')
    expect(projected.snapshot.activeTabId).toBe('terminal-a::leaf-a')
  })

  it('namespaces projections by device and discards revoked state', () => {
    const store = new ClientSessionTabSelectionStore()
    const initial = snapshot()

    store.project(initial, 'device-a')
    store.project(initial, 'device-b')
    const selectedA = store.activate(initial, 'device-a', 'browser-unified')

    expect(selectedA.activeTabId).toBe('browser-unified')
    expect(selectedA.publicationEpoch).toBe('renderer:1:client-navigation')
    expect(selectedA.snapshotVersion).toBe(2)
    expect(store.project(initial, 'device-b').activeTabId).toBe('terminal-a::leaf-a')
    const selectedAgain = store.activate(initial, 'device-a', 'terminal-a::leaf-b')
    expect(selectedAgain.snapshotVersion).toBe(3)
    expect(selectedAgain.activeTabId).toBe('terminal-a::leaf-b')
    store.forgetClient('device-a')
    expect(store.project(initial, 'device-a').activeTabId).toBe('terminal-a::leaf-a')
  })

  it('lands a device that has not picked a tab on the host focus', () => {
    const store = new ClientSessionTabSelectionStore()

    const projected = store.project(snapshot('browser-unified'), 'new-device')

    expect(projected.activeTabId).toBe('browser-unified')
    expect(projected.activeGroupId).toBe('group-right')
    expect(projected.tabs.find((tab) => tab.isActive)?.id).toBe('browser-unified')
    // A later open follows where the host moved, not the first projection.
    expect(store.project(snapshot('terminal-a::leaf-b'), 'new-device').activeTabId).toBe(
      'terminal-a::leaf-b'
    )
  })

  it('keeps a device on its own pick when the host moves', () => {
    const store = new ClientSessionTabSelectionStore()
    store.activate(snapshot(), 'device-a', 'browser-unified')

    expect(store.project(snapshot('terminal-a::leaf-b'), 'device-a').activeTabId).toBe(
      'browser-unified'
    )
  })

  it('persists activations and restores them across a store rebuild (host restart)', () => {
    const persisted: PersistedMobileClientTabSelections[] = []
    const store = new ClientSessionTabSelectionStore()
    store.setPersistListener((state) => persisted.push(state))

    store.activate(snapshot(), 'device-a', 'browser-unified')

    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.['device-a']?.['wt-1']?.activeTabId).toBe('browser-unified')

    const restarted = new ClientSessionTabSelectionStore()
    restarted.hydrate(persisted[0]!)
    const projected = restarted.project(snapshot(), 'device-a')

    expect(projected.activeTabId).toBe('browser-unified')
    expect(projected.tabs.find((tab) => tab.isActive)?.id).toBe('browser-unified')
    expect(restarted.project(snapshot(), 'device-b').activeTabId).toBe('terminal-a::leaf-a')
  })

  it('persists forgetClient and forgetWorktree removals', () => {
    const persisted: PersistedMobileClientTabSelections[] = []
    const store = new ClientSessionTabSelectionStore()
    store.activate(snapshot(), 'device-a', 'browser-unified')
    store.setPersistListener((state) => persisted.push(state))

    store.forgetWorktree('wt-1')
    expect(persisted.at(-1)).toEqual({})

    store.activate(snapshot(), 'device-a', 'browser-unified')
    store.forgetClient('device-a')
    expect(persisted.at(-1)).toEqual({})
    // Why: forgetting state that is already gone must not rewrite the persisted file.
    const writes = persisted.length
    store.forgetClient('device-a')
    store.forgetWorktree('wt-1')
    expect(persisted.length).toBe(writes)
  })

  it('moves persisted selections when a worktree identity changes', () => {
    const persisted: PersistedMobileClientTabSelections[] = []
    const store = new ClientSessionTabSelectionStore()
    store.activate(snapshot(), 'device-a', 'browser-unified')
    store.setPersistListener((state) => persisted.push(state))

    store.migrateWorktree('wt-1', 'wt-renamed')

    expect(persisted).toEqual([
      {
        'device-a': {
          'wt-renamed': {
            activeTabId: 'browser-unified',
            activeGroupId: 'group-right',
            activeTabIdByGroupId: {
              'group-left': 'terminal-a',
              'group-right': 'browser-unified'
            },
            recentTabIds: ['browser-unified']
          }
        }
      }
    ])
    expect(store.project({ ...snapshot(), worktree: 'wt-renamed' }, 'device-a').activeTabId).toBe(
      'browser-unified'
    )
  })

  it('does not persist topology-only projections from unrelated worktrees', () => {
    const persisted: PersistedMobileClientTabSelections[] = []
    const store = new ClientSessionTabSelectionStore()
    store.setPersistListener((state) => persisted.push(state))

    store.project({ ...snapshot(), worktree: 'listed-only' }, 'device-a')
    store.activate(snapshot(), 'device-a', 'browser-unified')

    expect(persisted).toEqual([
      {
        'device-a': {
          'wt-1': {
            activeTabId: 'browser-unified',
            activeGroupId: 'group-right',
            activeTabIdByGroupId: { 'group-right': 'browser-unified' },
            recentTabIds: ['browser-unified']
          }
        }
      }
    ])

    store.forgetWorktree('listed-only')
    expect(persisted).toHaveLength(1)
  })

  it('does not let an empty snapshot wipe a hydrated selection before tabs arrive', () => {
    const store = new ClientSessionTabSelectionStore()
    store.hydrate({
      'device-a': {
        'wt-1': { activeTabId: 'browser-unified', activeGroupId: null, activeTabIdByGroupId: {} }
      }
    })

    const empty = {
      ...snapshot(),
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabGroups: [],
      tabs: []
    }
    expect(store.project(empty, 'device-a').activeTabId).toBeNull()

    expect(store.project(snapshot(), 'device-a').activeTabId).toBe('browser-unified')
  })

  it('restores the selection after a snapshot transiently drops the selected tab', () => {
    const store = new ClientSessionTabSelectionStore()
    const full = snapshot()
    store.activate(full, 'device-a', 'browser-unified')

    // A browser guest process swap omits the tab from one snapshot.
    const withoutBrowser = {
      ...full,
      activeTabId: 'terminal-a::leaf-a',
      activeTabType: 'terminal' as const,
      tabs: full.tabs.filter((tab) => tab.id !== 'browser-unified')
    }
    expect(store.project(withoutBrowser, 'device-a').activeTabId).toBe('terminal-a::leaf-a')

    expect(store.project(full, 'device-a').activeTabId).toBe('browser-unified')
  })

  it('does not restore a closed tab from a stale pre-close snapshot', () => {
    const store = new ClientSessionTabSelectionStore()
    const full = snapshot()
    store.activate(full, 'device-a', 'browser-unified')
    store.activate(full, 'device-b', 'browser-unified')

    store.forgetTabs('wt-1', ['browser-unified'])

    for (const clientId of ['device-a', 'device-b']) {
      const stale = store.project(full, clientId)
      expect(stale.activeTabId).toBe('terminal-a::leaf-a')
      expect(stale.tabs.some((tab) => tab.id === 'browser-unified')).toBe(false)
    }

    const withoutBrowser = {
      ...full,
      activeTabId: 'terminal-a::leaf-a',
      activeTabType: 'terminal' as const,
      tabGroups: full.tabGroups?.slice(0, 1),
      tabs: full.tabs.filter((tab) => tab.id !== 'browser-unified')
    }
    store.project(withoutBrowser, 'device-a')
    const reused = store.project(full, 'device-a')
    expect(reused.activeTabId).toBe('terminal-a::leaf-a')
    expect(reused.tabs.some((tab) => tab.id === 'browser-unified')).toBe(true)
  })

  it('lets an explicit activation reuse a recently closed tab identity', () => {
    const store = new ClientSessionTabSelectionStore()
    const full = snapshot()
    store.activate(full, 'device-a', 'browser-unified')
    store.forgetTabs('wt-1', ['browser-unified'])

    const reopened = store.activate(full, 'device-a', 'browser-unified')

    expect(reopened.activeTabId).toBe('browser-unified')
    expect(reopened.tabs.some((tab) => tab.id === 'browser-unified')).toBe(true)
  })

  it('returns a device to the tab it viewed before when its shown tab closes on the desktop', () => {
    const store = new ClientSessionTabSelectionStore()
    const full = browserStrip(['a', 'b', 'c', 'd'], { hostActiveTabId: 'd' })
    for (const tabId of ['a', 'b', 'c']) {
      store.activate(full, 'device-a', tabId)
    }

    const closed = browserStrip(['a', 'b', 'd'], { hostActiveTabId: 'd' })

    expect(store.project(closed, 'device-a').activeTabId).toBe('b')
    expect(store.project(closed, 'device-a').activeTabId).toBe('b')
  })

  it('returns a device to the tab it viewed before when it closes its shown tab', () => {
    const store = new ClientSessionTabSelectionStore()
    const full = browserStrip(['a', 'b', 'c', 'd'], { hostActiveTabId: 'd' })
    for (const tabId of ['a', 'b', 'c']) {
      store.activate(full, 'device-a', tabId)
    }

    store.forgetTabs('wt-1', ['c'])

    expect(store.project(full, 'device-a').activeTabId).toBe('b')
    expect(store.project(browserStrip(['a', 'b', 'd']), 'device-a').activeTabId).toBe('b')
  })

  it("falls back to the closed tab's right neighbour when the device viewed no other tab", () => {
    const store = new ClientSessionTabSelectionStore()
    const full = browserStrip(['a', 'b', 'c', 'd'])
    store.project(full, 'device-a')
    store.activate(full, 'device-a', 'c')

    expect(store.project(browserStrip(['a', 'b', 'd']), 'device-a').activeTabId).toBe('d')
  })

  it('keeps the recency across a host restart', () => {
    const persisted: PersistedMobileClientTabSelections[] = []
    const store = new ClientSessionTabSelectionStore()
    store.setPersistListener((state) => persisted.push(state))
    const full = browserStrip(['a', 'b', 'c', 'd'], { hostActiveTabId: 'd' })
    for (const tabId of ['a', 'b', 'c']) {
      store.activate(full, 'device-a', tabId)
    }

    const restarted = new ClientSessionTabSelectionStore()
    restarted.hydrate(persisted.at(-1)!)

    expect(restarted.project(browserStrip(['a', 'b', 'd']), 'device-a').activeTabId).toBe('b')
  })

  it('moves a device to the split sibling when its shown group empties, as the desktop does', () => {
    const store = new ClientSessionTabSelectionStore()
    const full = splitBrowserStrips(['a', 'b', 'c'], ['doc'])
    store.activate(full, 'device-a', 'c')
    store.activate(full, 'device-a', 'doc')

    expect(store.project(splitBrowserStrips(['a', 'b', 'c'], []), 'device-a').activeTabId).toBe('c')
  })

  it("uses the host's recency for a selection saved before devices kept their own", () => {
    const store = new ClientSessionTabSelectionStore()
    store.hydrate({
      'device-a': {
        'wt-1': { activeTabId: 'c', activeGroupId: 'group', activeTabIdByGroupId: { group: 'c' } }
      }
    })

    const closed = browserStrip(['a', 'b', 'd'], { hostRecentTabIds: ['a', 'd', 'b'] })

    expect(store.project(closed, 'device-a').activeTabId).toBe('b')
  })

  it('drops malformed persisted payloads instead of hydrating them', () => {
    expect(
      normalizePersistedMobileClientTabSelections({
        'device-a': {
          'wt-1': { activeTabId: 'tab-1', activeGroupId: null, activeTabIdByGroupId: { g: 'tab' } },
          'wt-bad': { activeTabId: 42, activeGroupId: null, activeTabIdByGroupId: { g: 7 } }
        },
        'device-bad': 'nope',
        'device-empty': {}
      })
    ).toEqual({
      'device-a': {
        'wt-1': { activeTabId: 'tab-1', activeGroupId: null, activeTabIdByGroupId: { g: 'tab' } }
      }
    })
    expect(normalizePersistedMobileClientTabSelections(null)).toEqual({})
    expect(normalizePersistedMobileClientTabSelections('garbage')).toEqual({})
    expect(normalizePersistedMobileClientTabSelections([{ 'wt-1': {} }])).toEqual({})
    expect(
      normalizePersistedMobileClientTabSelections({
        'device-array': [{ activeTabId: 'tab-1' }],
        'device-selection-array': { 'wt-1': ['tab-1'] },
        'device-group-array': {
          'wt-1': { activeTabId: 'tab-1', activeGroupId: null, activeTabIdByGroupId: ['tab-1'] }
        }
      })
    ).toEqual({
      'device-group-array': {
        'wt-1': { activeTabId: 'tab-1', activeGroupId: null, activeTabIdByGroupId: {} }
      }
    })
  })
})
