import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-session-contracts'
import { resolveActiveTerminalPane } from './active-terminal-pane'

function terminalSurface(parentTabId: string, leafId: string): RuntimeMobileSessionSnapshotTab {
  return {
    type: 'terminal',
    id: `${parentTabId}::${leafId}`,
    title: 'Terminal',
    parentTabId,
    leafId,
    isActive: false
  }
}

const browserTab: RuntimeMobileSessionSnapshotTab = {
  type: 'browser',
  id: 'browser-1',
  title: 'Docs',
  browserWorkspaceId: 'browser-workspace-1',
  browserPageId: null,
  url: 'https://example.com',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: false
}

function snapshot(
  tabs: RuntimeMobileSessionSnapshotTab[],
  activeTabId: string | null,
  activeGroupId: string | null = null
): RuntimeMobileSessionTabsSnapshot {
  const active = tabs.find((tab) => tab.id === activeTabId)
  return {
    worktree: 'worktree-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId,
    activeTabId,
    activeTabType: active?.type ?? null,
    tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId }))
  }
}

describe('resolveActiveTerminalPane', () => {
  it('returns the pane of a single-pane active terminal tab', () => {
    expect(
      resolveActiveTerminalPane(
        snapshot(
          [terminalSurface('tab-1', 'pane:1'), terminalSurface('tab-2', 'pane:1')],
          'tab-2::pane:1'
        )
      )
    ).toEqual({ tabId: 'tab-2', leafId: 'pane:1' })
  })

  it('returns the focused leaf of a split terminal tab', () => {
    expect(
      resolveActiveTerminalPane(
        snapshot(
          [terminalSurface('tab-1', 'pane:1'), terminalSurface('tab-1', 'pane:2')],
          'tab-1::pane:2'
        )
      )
    ).toEqual({ tabId: 'tab-1', leafId: 'pane:2' })
  })

  it('follows the last focused tab group over another group with an active terminal', () => {
    const published = {
      ...snapshot(
        [terminalSurface('tab-left', 'pane:1'), terminalSurface('tab-right', 'pane:1')],
        'tab-right::pane:1',
        'group-right'
      ),
      tabGroups: [
        { id: 'group-left', activeTabId: 'tab-left', tabOrder: ['tab-left'] },
        { id: 'group-right', activeTabId: 'tab-right', tabOrder: ['tab-right'] }
      ]
    }

    expect(resolveActiveTerminalPane(published)).toEqual({ tabId: 'tab-right', leafId: 'pane:1' })
  })

  it('returns null when the active tab is not a terminal', () => {
    expect(
      resolveActiveTerminalPane(
        snapshot([terminalSurface('tab-1', 'pane:1'), browserTab], 'browser-1')
      )
    ).toBeNull()
  })

  it('returns null when the worktree has no published layout or no active tab', () => {
    expect(resolveActiveTerminalPane(undefined)).toBeNull()
    expect(
      resolveActiveTerminalPane(snapshot([terminalSurface('tab-1', 'pane:1')], null))
    ).toBeNull()
  })
})
