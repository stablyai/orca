import { describe, expect, it } from 'vitest'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  LAUNCHED_SELECTION_SNAPSHOT_BUDGET,
  isLaunchedSurfaceListed,
  launchedSelection,
  pendingSelectionHandle,
  pendingSelectionTabId,
  pendingSelectionWantsHandle,
  resolveLaunchedSelection,
  withLaunchReply,
  withoutPendingHandle,
  withoutPendingTabId,
  withoutUnansweredLaunch,
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

const PANE = {
  tabId: 'b1d3c0de-0000-4000-8000-000000000001',
  leafId: 'b1d3c0de-0000-4000-8000-000000000002'
}

function reservedTerminalTab(terminal: string | null): MobileSessionTab {
  return {
    type: 'terminal',
    id: `${PANE.tabId}::${PANE.leafId}`,
    parentTabId: PANE.tabId,
    leafId: PANE.leafId,
    title: 'Claude',
    terminal,
    isActive: false
  }
}

describe('resolveLaunchedSelection', () => {
  it('finds a launched chat by its session id, whatever its tab id is', () => {
    const tabs = [chatTab('opaque-tab-7', 'claude_s1')]
    expect(
      resolveLaunchedSelection(launchedSelection('l1', { sessionId: 'claude_s1' }), tabs)
    ).toEqual({
      selection: { kind: 'tab', tabId: 'opaque-tab-7' },
      landedTabId: 'opaque-tab-7'
    })
  })

  it('finds a launched terminal by the pane this device reserved, before any reply', () => {
    const selection = launchedSelection('l1', { pane: PANE }, null)
    expect(resolveLaunchedSelection(selection, [reservedTerminalTab('term_9')])).toEqual({
      selection: { kind: 'terminal', handle: 'term_9', tabId: `${PANE.tabId}::${PANE.leafId}` },
      landedTabId: `${PANE.tabId}::${PANE.leafId}`
    })
    // Listed before its handle is issued: landed by tab id alone.
    expect(resolveLaunchedSelection(selection, [reservedTerminalTab(null)]).selection).toEqual({
      kind: 'tab',
      tabId: `${PANE.tabId}::${PANE.leafId}`
    })
  })

  it('never takes a chat for the reserved pane: a chat is listed under its session', () => {
    const selection = launchedSelection('l1', { pane: PANE }, null)
    expect(
      resolveLaunchedSelection(selection, [chatTab(PANE.tabId, 'claude_other')]).landedTabId
    ).toBeNull()
  })

  it("finds a terminal by the reply's handle when the host ignored the reservation", () => {
    const tabs = [terminalTab('tab-2', 'term_9')]
    const selection = withLaunchReply(launchedSelection('l1', { pane: PANE }, null), 'l1', {
      handle: 'term_9'
    })
    expect(resolveLaunchedSelection(selection, tabs)).toEqual({
      selection: { kind: 'terminal', handle: 'term_9', tabId: 'tab-2' },
      landedTabId: 'tab-2'
    })
  })

  it('waits without a countdown until the reply, then gives up after the budget', () => {
    let selection: PendingSessionSelection | null = launchedSelection('l1', { pane: PANE }, null)
    for (let snapshot = 0; snapshot < LAUNCHED_SELECTION_SNAPSHOT_BUDGET * 2; snapshot += 1) {
      selection = resolveLaunchedSelection(selection, []).selection
    }
    expect(selection).toEqual(launchedSelection('l1', { pane: PANE }, null))

    selection = withLaunchReply(selection, 'l1', { handle: 'term_9' })
    for (let snapshot = 1; snapshot < LAUNCHED_SELECTION_SNAPSHOT_BUDGET; snapshot += 1) {
      const next = resolveLaunchedSelection(selection, [chatTab('other', 'claude_other')])
      expect(next.landedTabId).toBeNull()
      expect(next.selection?.kind).toBe('launched')
      selection = next.selection
    }
    expect(resolveLaunchedSelection(selection, []).selection).toBeNull()
  })

  it('leaves an ordinary pick alone', () => {
    const pick: PendingSessionSelection = { kind: 'tab', tabId: 'tab-1' }
    expect(resolveLaunchedSelection(pick, [])).toEqual({ selection: pick, landedTabId: null })
  })
})

describe("a launch's own reply and end", () => {
  const pick: PendingSessionSelection = { kind: 'tab', tabId: 'tab-1' }

  it('act only on that launch, never on a pick or a newer launch', () => {
    const newer = launchedSelection('l2', { pane: PANE }, null)
    expect(withLaunchReply(pick, 'l1', { handle: 'term_9' })).toBe(pick)
    expect(withLaunchReply(newer, 'l1', { handle: 'term_9' })).toBe(newer)
    expect(withoutUnansweredLaunch(pick, 'l1')).toBe(pick)
    expect(withoutUnansweredLaunch(newer, 'l1')).toBe(newer)
  })

  it('drops a launch that ended unanswered and keeps one its reply named', () => {
    const waiting = launchedSelection('l1', { pane: PANE }, null)
    expect(withoutUnansweredLaunch(waiting, 'l1')).toBeNull()
    const answered = withLaunchReply(waiting, 'l1', { handle: 'term_9' })
    expect(withoutUnansweredLaunch(answered, 'l1')).toBe(answered)
  })
})

describe('the halves of a pick', () => {
  const both: PendingSessionSelection = { kind: 'terminal', handle: 'term_1', tabId: 'tab-1' }

  it('reads the tab id and handle', () => {
    expect(pendingSelectionTabId(both)).toBe('tab-1')
    expect(pendingSelectionHandle(both)).toBe('term_1')
    expect(pendingSelectionTabId(launchedSelection('l1', { handle: 'term_1' }))).toBeNull()
  })

  it('drops one half and keeps the other', () => {
    expect(withoutPendingTabId(both)).toEqual({ kind: 'terminal', handle: 'term_1', tabId: null })
    expect(withoutPendingHandle(both)).toEqual({ kind: 'tab', tabId: 'tab-1' })
    expect(withoutPendingHandle({ kind: 'terminal', handle: 'term_1', tabId: null })).toBeNull()
    expect(withoutPendingTabId({ kind: 'tab', tabId: 'tab-1' })).toBeNull()
  })

  it('lets a just-launched terminal subscribe before its tab arrives', () => {
    expect(
      pendingSelectionWantsHandle(launchedSelection('l1', { handle: 'term_1' }), 'term_1')
    ).toBe(true)
    expect(pendingSelectionWantsHandle(launchedSelection('l1', { sessionId: 's' }), 'term_1')).toBe(
      false
    )
  })
})

describe('isLaunchedSurfaceListed', () => {
  it('reads a listed terminal as a started agent', () => {
    expect(isLaunchedSurfaceListed([reservedTerminalTab('term_1')], { pane: PANE })).toBe(true)
  })

  it('does not read a tab the host showed before its agent existed as a start', () => {
    expect(isLaunchedSurfaceListed([reservedTerminalTab(null)], { pane: PANE })).toBe(false)
  })

  it('still lands the selection on that tab, so the phone shows it at once', () => {
    const resolved = resolveLaunchedSelection(launchedSelection('lock', { pane: PANE }, null), [
      reservedTerminalTab(null)
    ])
    expect(resolved.landedTabId).toBe(`${PANE.tabId}::${PANE.leafId}`)
  })
})
