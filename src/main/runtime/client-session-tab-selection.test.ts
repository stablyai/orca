import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import {
  activateClientSessionTabSelection,
  ClientSessionTabSelectionStore,
  deriveClientSessionTabSelection,
  projectClientSessionTabSelection
} from './client-session-tab-selection'

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
})
