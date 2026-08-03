import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { PersistedMobileClientTabSelections } from '../../shared/types'
import {
  activateClientSessionTabSelection,
  ClientSessionTabSelectionStore,
  deriveClientSessionTabSelection,
  projectClientSessionTabSelection
} from './client-session-tab-selection'
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

  it('does not expose host focus when initializing a new paired device', () => {
    const store = new ClientSessionTabSelectionStore()
    const hostFocusedBrowser = snapshot('browser-unified')

    const projected = store.project(hostFocusedBrowser, 'new-device')

    expect(projected.activeTabId).toBe('terminal-a::leaf-a')
    expect(projected.activeGroupId).toBe('group-left')
    expect(projected.tabs.find((tab) => tab.isActive)?.id).toBe('terminal-a::leaf-a')
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
            }
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
            activeTabIdByGroupId: { 'group-right': 'browser-unified' }
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
