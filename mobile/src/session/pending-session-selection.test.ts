import { describe, expect, it } from 'vitest'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  LAUNCHED_SELECTION_SNAPSHOT_BUDGET,
  launchedSelection,
  pendingSelectionHandle,
  pendingSelectionTabId,
  pendingSelectionWantsHandle,
  resolveLaunchedSelection,
  withoutPendingHandle,
  withoutPendingTabId,
  type PendingSessionSelection
} from './pending-session-selection'

function terminalTab(id: string, terminal: string): MobileSessionTab {
  const tab: MobileSessionTab = {
    type: 'terminal',
    id,
    parentTabId: id,
    leafId: 'leaf',
    title: 'Terminal',
    terminal,
    isActive: false
  }
  return tab
}

function chatTab(id: string, sessionId: string): MobileSessionTab {
  const tab: MobileSessionTab = {
    type: 'agent-session',
    id,
    title: 'Claude Chat',
    sessionId,
    agent: 'claude',
    isActive: false
  }
  return tab
}

describe('resolveLaunchedSelection', () => {
  it('finds a launched chat by its session id, whatever its tab id is', () => {
    const tabs = [chatTab('opaque-tab-7', 'claude_s1')]
    expect(resolveLaunchedSelection(launchedSelection({ sessionId: 'claude_s1' }), tabs)).toEqual({
      selection: { kind: 'tab', tabId: 'opaque-tab-7' },
      missed: false
    })
  })

  it('finds a launched terminal by its handle and keeps the handle', () => {
    const tabs = [terminalTab('tab-2', 'term_9')]
    expect(resolveLaunchedSelection(launchedSelection({ handle: 'term_9' }), tabs)).toEqual({
      selection: { kind: 'terminal', handle: 'term_9', tabId: 'tab-2' },
      missed: false
    })
  })

  it('keeps waiting across snapshots that lack the tab, then gives up', () => {
    let selection: PendingSessionSelection | null = launchedSelection({ sessionId: 'claude_s1' })
    for (let snapshot = 1; snapshot < LAUNCHED_SELECTION_SNAPSHOT_BUDGET; snapshot += 1) {
      const next = resolveLaunchedSelection(selection, [chatTab('other', 'claude_other')])
      expect(next.missed).toBe(true)
      expect(next.selection?.kind).toBe('launched')
      selection = next.selection
    }
    expect(resolveLaunchedSelection(selection, []).selection).toBeNull()
  })

  it('leaves an ordinary pick alone', () => {
    const pick: PendingSessionSelection = { kind: 'tab', tabId: 'tab-1' }
    expect(resolveLaunchedSelection(pick, [])).toEqual({ selection: pick, missed: false })
  })
})

describe('the halves of a pick', () => {
  const both: PendingSessionSelection = { kind: 'terminal', handle: 'term_1', tabId: 'tab-1' }

  it('reads the tab id and handle', () => {
    expect(pendingSelectionTabId(both)).toBe('tab-1')
    expect(pendingSelectionHandle(both)).toBe('term_1')
    expect(pendingSelectionTabId(launchedSelection({ handle: 'term_1' }))).toBeNull()
  })

  it('drops one half and keeps the other', () => {
    expect(withoutPendingTabId(both)).toEqual({ kind: 'terminal', handle: 'term_1', tabId: null })
    expect(withoutPendingHandle(both)).toEqual({ kind: 'tab', tabId: 'tab-1' })
    expect(withoutPendingHandle({ kind: 'terminal', handle: 'term_1', tabId: null })).toBeNull()
    expect(withoutPendingTabId({ kind: 'tab', tabId: 'tab-1' })).toBeNull()
  })

  it('lets a just-launched terminal subscribe before its tab arrives', () => {
    expect(pendingSelectionWantsHandle(launchedSelection({ handle: 'term_1' }), 'term_1')).toBe(
      true
    )
    expect(pendingSelectionWantsHandle(launchedSelection({ sessionId: 's' }), 'term_1')).toBe(false)
  })
})
