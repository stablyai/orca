import { describe, expect, it } from 'vitest'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES
} from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  assertProjectedSessionTabVisible,
  clientCanObserveClientHostedBrowserPages,
  projectSessionTabBrowserPlacements,
  translateProjectedSessionTabMove
} from './session-tab-browser-placement-projection'

describe('projectSessionTabBrowserPlacements', () => {
  it('preserves exact client placement for a capable desktop', () => {
    const snapshot = makeSnapshot()

    expect(
      projectSessionTabBrowserPlacements(snapshot, [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY])
    ).toBe(snapshot)
  })

  it('removes client-only pages and repairs focus for an old peer', () => {
    const projected = projectSessionTabBrowserPlacements(makeSnapshot(), [])

    expect(projected.tabs).toEqual([
      expect.objectContaining({ id: 'terminal-leaf', isActive: true })
    ])
    expect(projected.activeTabId).toBe('terminal-leaf')
    expect(projected.activeTabType).toBe('terminal')
    expect(projected.activeGroupId).toBe('group-terminal')
    expect(projected.tabGroups).toEqual([
      {
        id: 'group-terminal',
        activeTabId: 'terminal-parent',
        tabOrder: ['terminal-parent'],
        recentTabIds: ['terminal-parent']
      }
    ])
    expect(projected.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'group-terminal' })
  })

  // Why named here: a CLI socket sends no capabilities at all, so anything asking it for browser
  // tabs — an e2e oracle included — is blind to every client-placed page by design.
  it('hides client-placed pages from a native peer and from a caller with no capabilities', () => {
    expect(
      clientCanObserveClientHostedBrowserPages(NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
    ).toBe(false)
    expect(
      clientCanObserveClientHostedBrowserPages(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
    ).toBe(true)
    expect(clientCanObserveClientHostedBrowserPages(undefined)).toBe(false)
    expect(projectSessionTabBrowserPlacements(makeSnapshot(), undefined).tabs).toEqual([
      expect.objectContaining({ id: 'terminal-leaf' })
    ])
  })

  it('preserves hidden raw slots while translating an old-client reorder', () => {
    const raw = mixedGroupSnapshot()
    const projected = projectSessionTabBrowserPlacements(raw, [])

    expect(
      translateProjectedSessionTabMove(raw, projected, {
        kind: 'reorder',
        tabId: 'terminal-c',
        targetGroupId: 'group-a',
        tabOrder: ['terminal-c', 'terminal-a', 'terminal-b']
      })
    ).toEqual({
      kind: 'reorder',
      tabId: 'terminal-c',
      targetGroupId: 'group-a',
      tabOrder: ['terminal-c', 'hidden-a', 'terminal-a', 'hidden-b', 'terminal-b']
    })
  })

  it('translates a visible insertion index to the raw group index', () => {
    const raw = mixedGroupSnapshot()
    const projected = projectSessionTabBrowserPlacements(raw, [])

    expect(
      translateProjectedSessionTabMove(raw, projected, {
        kind: 'move-to-group',
        tabId: 'terminal-c',
        targetGroupId: 'group-a',
        index: 1
      })
    ).toMatchObject({ index: 2 })
    expect(
      translateProjectedSessionTabMove(raw, projected, {
        kind: 'move-to-group',
        tabId: 'terminal-c',
        targetGroupId: 'group-a',
        index: 3
      })
    ).toMatchObject({ index: 5 })
  })

  it('rejects hidden tabs, hidden groups, and incomplete visible orders', () => {
    const raw = mixedGroupSnapshot()
    const projected = projectSessionTabBrowserPlacements(raw, [])

    expect(() => assertProjectedSessionTabVisible(projected, 'hidden-a')).toThrow('tab_not_found')
    expect(() =>
      translateProjectedSessionTabMove(raw, projected, {
        kind: 'split',
        tabId: 'terminal-a',
        targetGroupId: 'hidden-group',
        splitDirection: 'right'
      })
    ).toThrow('target_group_not_found')
    expect(() =>
      translateProjectedSessionTabMove(raw, projected, {
        kind: 'reorder',
        tabId: 'terminal-a',
        targetGroupId: 'group-a',
        tabOrder: ['terminal-a', 'terminal-b']
      })
    ).toThrow('invalid_tab_order')
  })
})

function makeSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-browser',
    activeTabId: 'page-client',
    activeTabType: 'browser',
    tabGroups: [
      {
        id: 'group-terminal',
        activeTabId: 'terminal-parent',
        tabOrder: ['terminal-parent'],
        recentTabIds: ['terminal-parent']
      },
      {
        id: 'group-browser',
        activeTabId: 'page-client',
        tabOrder: ['page-client'],
        recentTabIds: ['page-client']
      }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-terminal' },
      second: { type: 'leaf', groupId: 'group-browser' }
    },
    tabs: [
      {
        type: 'terminal',
        id: 'terminal-leaf',
        parentTabId: 'terminal-parent',
        leafId: 'leaf-1',
        title: 'Terminal',
        isActive: false,
        status: 'ready',
        terminal: 'term-1'
      },
      {
        type: 'browser',
        id: 'page-client',
        title: 'Browser',
        browserWorkspaceId: 'page-client',
        browserPageId: 'page-client',
        url: 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        placement: {
          kind: 'client',
          browserHostClientId: 'host-a',
          browserHostGeneration: 3,
          pageHostGeneration: 9
        },
        isActive: true
      }
    ]
  }
}

function mixedGroupSnapshot(): RuntimeMobileSessionTabsResult {
  const terminal = (parentTabId: string) => ({
    type: 'terminal' as const,
    id: `${parentTabId}-leaf`,
    parentTabId,
    leafId: `${parentTabId}-leaf`,
    title: parentTabId,
    isActive: parentTabId === 'terminal-a',
    status: 'ready' as const,
    terminal: `${parentTabId}-pty`
  })
  const browser = (id: string) => ({
    type: 'browser' as const,
    id,
    title: id,
    browserWorkspaceId: id,
    browserPageId: id,
    url: 'about:blank',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    placement: {
      kind: 'client' as const,
      browserHostClientId: 'host-a',
      browserHostGeneration: 3,
      pageHostGeneration: id === 'hidden-a' ? 9 : 10
    },
    isActive: false
  })
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-a',
    activeTabId: 'terminal-a-leaf',
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: 'group-a',
        activeTabId: 'terminal-a',
        tabOrder: ['terminal-a', 'hidden-a', 'terminal-b', 'hidden-b', 'terminal-c']
      },
      { id: 'hidden-group', activeTabId: 'hidden-c', tabOrder: ['hidden-c'] }
    ],
    tabs: [
      terminal('terminal-a'),
      browser('hidden-a'),
      terminal('terminal-b'),
      browser('hidden-b'),
      terminal('terminal-c'),
      browser('hidden-c')
    ]
  }
}
