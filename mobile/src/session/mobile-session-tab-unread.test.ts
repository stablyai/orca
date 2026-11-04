import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { setCachedWorktrees } from '../cache/worktree-cache'
import {
  resolveHostAgentRowDotState,
  resolveHostWorktreeRowStatus
} from './catalog-worktree-unread-status'
import {
  buildRecentSessionCardFromTab,
  clearTabCompletionTrackerForTests,
  isMobileSessionTabUnreadBeforeView,
  resolveMobileSessionTabDotState,
  seedUnreadWorktreeSessionTabs,
  setCatalogWorktreesForTabStatus,
  syncRecentCardWithLiveTab
} from './mobile-terminal-tab-agent'

function doneTerminalTab(id: string, stamp: number, isActive = false) {
  return {
    type: 'terminal' as const,
    id,
    terminal: `pty-${id}`,
    isActive,
    agentStatus: {
      state: 'done' as const,
      prompt: 'fix bug',
      paneKey: `${id}:leaf-1`,
      stateHistory: [],
      updatedAt: stamp,
      stateStartedAt: stamp
    }
  }
}

function catalogAgent(paneKey: string, state: 'working' | 'done', stamp: number) {
  return { paneKey, state, updatedAt: stamp, stateStartedAt: stamp }
}

function expectOffscreen(id: string, stamp: number, state: 'done' | 'unread') {
  expect(
    resolveMobileSessionTabDotState(doneTerminalTab(id, stamp), stamp, { isActiveOnScreen: false })
  ).toBe(state)
}

describe('unread worktree tab completion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    clearTabCompletionTrackerForTests()
  })

  afterEach(() => {
    clearTabCompletionTrackerForTests()
    vi.useRealTimers()
  })

  it('marks a catalog-tracked background completion unread when the worktree is entered', () => {
    setCatalogWorktreesForTabStatus(
      [{ worktreeId: 'wt-1', agents: [catalogAgent('tab-bg:leaf-1', 'working', 100)] }],
      100
    )
    setCatalogWorktreesForTabStatus(
      [{ worktreeId: 'wt-1', agents: [catalogAgent('tab-bg:leaf-1', 'done', 200)] }],
      200
    )
    expectOffscreen('tab-bg', 200, 'unread')

    const writeCache = (
      host: string,
      wt: string,
      pane: string,
      state: 'working' | 'done',
      proven = false
    ) =>
      setCachedWorktrees(
        host,
        [
          {
            worktreeId: wt,
            agents: [catalogAgent(pane, state, state === 'done' ? 1_005 : 1_000)]
          }
        ],
        proven ? { proven: true } : undefined
      )
    writeCache('host-unproven', 'wt-unproven', 'tab-seed:leaf-1', 'working')
    writeCache('host-unproven', 'wt-unproven', 'tab-seed:leaf-1', 'done')
    expectOffscreen('tab-seed', 1_005, 'done')
    writeCache('host-proven', 'wt-proven', 'tab-proven:leaf-1', 'working', true)
    writeCache('host-proven', 'wt-proven', 'tab-proven:leaf-1', 'done', true)
    expectOffscreen('tab-proven', 1_005, 'unread')
  })

  it('marks the latest completed tab unread for a cold-start unread worktree', () => {
    setCatalogWorktreesForTabStatus(
      [
        {
          worktreeId: 'wt-cold',
          unread: true,
          agents: [
            catalogAgent('tab-old:leaf-1', 'done', 100),
            catalogAgent('tab-new:leaf-1', 'done', 300)
          ]
        }
      ],
      300
    )
    expect(
      resolveMobileSessionTabDotState(doneTerminalTab('tab-old', 100), 300, {
        isActiveOnScreen: false
      })
    ).toBe('done')
    expectOffscreen('tab-new', 300, 'unread')

    setCatalogWorktreesForTabStatus([{ worktreeId: 'wt-seed', unread: true }], 400)
    const older = doneTerminalTab('tab-seed-old', 100)
    const active = doneTerminalTab('tab-seed-active', 400, true)
    const newer = doneTerminalTab('tab-seed-new', 500)
    seedUnreadWorktreeSessionTabs('wt-seed', [older, active, newer], 500)
    expect(resolveMobileSessionTabDotState(older, 500, { isActiveOnScreen: false })).toBe('done')
    expect(resolveMobileSessionTabDotState(active, 500, { isActiveOnScreen: false })).toBe('done')
    expectOffscreen('tab-seed-new', 500, 'unread')

    setCatalogWorktreesForTabStatus([{ worktreeId: 'wt-tie', unread: true }], 600)
    const idle = doneTerminalTab('tab-tie-idle', 600)
    const focused = doneTerminalTab('tab-tie-focus', 600, true)
    seedUnreadWorktreeSessionTabs('wt-tie', [idle, focused], 600)
    expect(resolveMobileSessionTabDotState(idle, 600, { isActiveOnScreen: false })).toBe('done')
    expectOffscreen('tab-tie-focus', 600, 'unread')
  })

  it('reconciles stale catalog working rows with session done without fabricating an unread bell', () => {
    const staleRow: RuntimeWorktreeAgentRow = {
      paneKey: 'tab-stale:leaf-1',
      parentPaneKey: null,
      state: 'working',
      agentType: 'claude',
      prompt: '',
      taskTitle: null,
      displayName: null,
      lastAssistantMessage: null,
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: 100,
      updatedAt: 100
    }
    setCatalogWorktreesForTabStatus(
      [{ worktreeId: 'wt-stale', unread: false, agents: [staleRow] }],
      100
    )
    const sessionDoneTab = {
      ...doneTerminalTab('tab-stale', 500),
      agentStatus: {
        ...doneTerminalTab('tab-stale', 500).agentStatus,
        prompt: ''
      }
    }
    expect(resolveMobileSessionTabDotState(sessionDoneTab, 500, { isActiveOnScreen: false })).toBe(
      'done'
    )
    expect(resolveHostAgentRowDotState(staleRow, 500)).toBe('done')
    expect(
      resolveHostWorktreeRowStatus(
        { worktreeId: 'wt-stale', unread: false, agents: [staleRow] },
        'working',
        500
      )
    ).toEqual({ status: 'done', unread: false })
  })

  it('keeps host worktree and agent rows unread while a background tab bell is unacknowledged', () => {
    const doneRow: RuntimeWorktreeAgentRow = {
      paneKey: 'tab-bell:leaf-1',
      parentPaneKey: null,
      state: 'done',
      agentType: 'claude',
      prompt: 'fix bug',
      taskTitle: null,
      displayName: null,
      lastAssistantMessage: 'Fixed',
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: 300,
      updatedAt: 300
    }
    setCatalogWorktreesForTabStatus(
      [{ worktreeId: 'wt-bell', unread: true, agents: [doneRow] }],
      300
    )
    expectOffscreen('tab-bell', 300, 'unread')
    expect(resolveHostAgentRowDotState(doneRow, 300)).toBe('unread')
    expect(
      resolveHostWorktreeRowStatus(
        { worktreeId: 'wt-bell', unread: false, agents: [doneRow] },
        'working',
        300
      )
    ).toEqual({ status: 'done', unread: true })

    expect(
      resolveMobileSessionTabDotState(doneTerminalTab('tab-bell', 300, true), 300, {
        isActiveOnScreen: true
      })
    ).toBe('done')
    expect(resolveHostAgentRowDotState(doneRow, 300)).toBe('done')
    expect(
      resolveHostWorktreeRowStatus(
        { worktreeId: 'wt-bell', unread: true, agents: [doneRow] },
        'done',
        300
      )
    ).toEqual({ status: 'done', unread: false })
  })

  it('marks the latest done agent unread even when another agent in the same worktree is working', () => {
    const workingRow: RuntimeWorktreeAgentRow = {
      paneKey: 'tab-work:leaf-1',
      parentPaneKey: null,
      state: 'working',
      agentType: 'claude',
      prompt: 'still running',
      taskTitle: null,
      displayName: null,
      lastAssistantMessage: null,
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: 400,
      updatedAt: 400
    }
    const doneRow: RuntimeWorktreeAgentRow = {
      paneKey: 'tab-done-mixed:leaf-1',
      parentPaneKey: null,
      state: 'done',
      agentType: 'claude',
      prompt: 'finished',
      taskTitle: null,
      displayName: null,
      lastAssistantMessage: 'All done',
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: 350,
      updatedAt: 350
    }
    expect(
      resolveHostWorktreeRowStatus(
        { worktreeId: 'wt-mixed', unread: true, agents: [doneRow, workingRow] },
        'working',
        400
      )
    ).toEqual({ status: 'working', unread: true })
    expect(resolveHostAgentRowDotState(doneRow, 400)).toBe('unread')
    expect(resolveHostAgentRowDotState(workingRow, 400)).toBe('working')
    expectOffscreen('tab-done-mixed', 350, 'unread')
  })

  it('preserves unread state across structured agent-session keys and pre-render recent card snapshots', () => {
    const structuredDoneRow: RuntimeWorktreeAgentRow = {
      paneKey: 'structured-agent-session-sid-1:leaf-1',
      parentPaneKey: null,
      state: 'done',
      agentType: 'claude',
      prompt: 'consensus check',
      taskTitle: null,
      displayName: null,
      lastAssistantMessage: 'Resolved',
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: 500,
      updatedAt: 500
    }
    setCatalogWorktreesForTabStatus(
      [{ worktreeId: 'wt-structured', unread: true, agents: [structuredDoneRow] }],
      500
    )
    const activeStructuredTab = {
      type: 'agent-session' as const,
      id: 'agent-session:sid-1',
      title: '共识与现实冲突',
      sessionId: 'sid-1',
      agent: 'claude' as const,
      isActive: true,
      chatStatus: { state: 'done' as const, updatedAt: 500 }
    }
    // Pre-render recent card snapshot / reconciliation must not wipe unreadBeforeView.
    const card = buildRecentSessionCardFromTab({
      hostId: 'host-1',
      worktreeId: 'wt-structured',
      worktreeName: 'main',
      tab: activeStructuredTab,
      now: 500
    })
    expect(card.agentState).toBe('done')
    expect(
      syncRecentCardWithLiveTab({ ...card, agentState: 'unread' }, activeStructuredTab, {
        isActiveOnScreen: true
      }).agentState
    ).toBe('done')
    expect(isMobileSessionTabUnreadBeforeView(activeStructuredTab, 500)).toBe(true)
  })
})
