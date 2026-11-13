import { describe, expect, it } from 'vitest'
import type { MobileSessionTab } from './mobile-session-tabs'
import {
  isLaunchedSurfaceListed,
  launchedSelection,
  resolveLaunchedSelection,
  withLaunchReply,
  withoutUnansweredLaunch,
  type PendingSessionSelection
} from './pending-session-selection'

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
  it('never takes a chat for the reserved pane: a chat is listed under its session', () => {
    const selection = launchedSelection('l1', { pane: PANE }, null)
    expect(
      resolveLaunchedSelection(selection, [chatTab(PANE.tabId, 'claude_other')]).landedTabId
    ).toBeNull()
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
})

describe('isLaunchedSurfaceListed', () => {
  it('does not read a tab the host showed before its agent existed as a start', () => {
    expect(isLaunchedSurfaceListed([reservedTerminalTab(null)], { pane: PANE })).toBe(false)
  })
})
