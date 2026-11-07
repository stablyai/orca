import { describe, expect, it } from 'vitest'
import type { NavContext, NavState } from './nav-contract'
import {
  DASHBOARD_ROWS_PER_PAGE,
  reduceDashboardClick,
  reduceDashboardScroll,
  type DashboardFrame
} from './hud-navigation-dashboard'

function fixtureCtx(overrides: Partial<NavContext> = {}): NavContext {
  return {
    hostCount: 1,
    worktreeCount: () => 0,
    dashboardPageCount: () => 1,
    worktreeListPageCount: () => 1,
    terminalTailPageCount: () => 1,
    pendingAskNotificationId: () => null,
    askOptionCount: () => 3,
    hostIdAt: () => null,
    worktreeIdAt: () => null,
    notificationWorktreeId: () => null,
    askSendInFlight: () => false,
    ...overrides
  }
}

function stateOf(frame: DashboardFrame): NavState {
  return { stack: [frame], exitDialogArmed: false }
}

describe('reduceDashboardScroll — MEDIUM #7 single cursor across pages', () => {
  it('moves the cursor past a page boundary and turns the page in the same motion', () => {
    const frame: DashboardFrame = {
      screen: 'dashboard',
      hostId: 'h1',
      cursor: DASHBOARD_ROWS_PER_PAGE - 1,
      page: 0
    }
    const ctx = fixtureCtx({ worktreeCount: () => DASHBOARD_ROWS_PER_PAGE + 1 })
    const { state, effects } = reduceDashboardScroll(stateOf(frame), ctx, frame, 1)
    expect(state.stack[0]).toEqual({
      screen: 'dashboard',
      hostId: 'h1',
      cursor: DASHBOARD_ROWS_PER_PAGE,
      page: 1
    })
    expect(effects).toEqual([])
  })

  it('does not scroll past the last row', () => {
    const frame: DashboardFrame = { screen: 'dashboard', hostId: 'h1', cursor: 2, page: 0 }
    const input = stateOf(frame)
    const ctx = fixtureCtx({ worktreeCount: () => 3 })
    const { state } = reduceDashboardScroll(input, ctx, frame, 1)
    expect(state).toBe(input)
  })

  it('is a no-op with zero rows', () => {
    const frame: DashboardFrame = { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 }
    const input = stateOf(frame)
    const { state, effects } = reduceDashboardScroll(input, fixtureCtx(), frame, 1)
    expect(state).toBe(input)
    expect(effects).toEqual([])
  })

  it('scrolling backward turns the page back down when crossing a page boundary', () => {
    const frame: DashboardFrame = {
      screen: 'dashboard',
      hostId: 'h1',
      cursor: DASHBOARD_ROWS_PER_PAGE,
      page: 1
    }
    const ctx = fixtureCtx({ worktreeCount: () => DASHBOARD_ROWS_PER_PAGE + 5 })
    const { state } = reduceDashboardScroll(stateOf(frame), ctx, frame, -1)
    expect(state.stack[0]).toEqual({
      screen: 'dashboard',
      hostId: 'h1',
      cursor: DASHBOARD_ROWS_PER_PAGE - 1,
      page: 0
    })
  })
})

describe('reduceDashboardClick — MEDIUM #7 click always opens the cursor, any page', () => {
  it('opens the worktree at the cursor on a later page, not always page 0', () => {
    const cursor = DASHBOARD_ROWS_PER_PAGE + 2
    const frame: DashboardFrame = { screen: 'dashboard', hostId: 'h1', cursor, page: 1 }
    const ctx = fixtureCtx({
      worktreeCount: () => DASHBOARD_ROWS_PER_PAGE + 5,
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === cursor ? 'wt-target' : null)
    })
    const { state, effects } = reduceDashboardClick(stateOf(frame), ctx, frame)
    expect(state.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-target',
      terminalId: '',
      page: 0
    })
    expect(effects).toEqual([{ kind: 'openTerminalTail', worktreeId: 'wt-target' }])
  })

  it('clamps a stale cursor left over from a row-set shrink before resolving the click', () => {
    const frame: DashboardFrame = { screen: 'dashboard', hostId: 'h1', cursor: 5, page: 0 }
    const ctx = fixtureCtx({
      worktreeCount: () => 2,
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === 1 ? 'wt-last' : null)
    })
    const { state, effects } = reduceDashboardClick(stateOf(frame), ctx, frame)
    expect(state.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-last',
      terminalId: '',
      page: 0
    })
    expect(effects).toEqual([{ kind: 'openTerminalTail', worktreeId: 'wt-last' }])
  })

  it('never pushes a worktreeList frame — click always resolves to a worktree or no-ops', () => {
    const frame: DashboardFrame = { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 }
    const { state, effects } = reduceDashboardClick(stateOf(frame), fixtureCtx(), frame)
    expect(state.stack).toEqual([frame])
    expect(effects).toEqual([])
  })
})
