import { describe, expect, it } from 'vitest'
import type { NavContext, NavState } from './nav-contract'
import { reduceWorktreeListSelect, type WorktreeListFrame } from './hud-navigation-list-select'

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

function stateOf(frame: WorktreeListFrame): NavState {
  return { stack: [frame], exitDialogArmed: false }
}

describe('reduceWorktreeListSelect — HIGH #16 page normalization on a row-set shrink', () => {
  it('clamps a stale page-1 offset after a 21 -> 20 shrink collapses to a single page', () => {
    // Wearer was viewing the lone 21st-row page; a poll lands with only 20 rows, collapsing
    // worktreeListPageCount to 1. The click's local index (5, real — from the now-current page 0
    // rendering) must resolve against the CLAMPED page, not the stale tracked page=1, or it adds
    // a phantom 20-row offset and the click silently does nothing.
    const frame: WorktreeListFrame = {
      screen: 'worktreeList',
      hostId: 'h1',
      selectedIndex: 20,
      page: 1
    }
    const ctx = fixtureCtx({
      worktreeCount: () => 20,
      worktreeListPageCount: () => 1,
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === 5 ? 'wt-5' : null)
    })
    const { state, effects } = reduceWorktreeListSelect(stateOf(frame), ctx, frame, 5, undefined)
    expect(state.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-5',
      terminalId: '',
      page: 0
    })
    expect(effects).toEqual([{ kind: 'openTerminalTail', worktreeId: 'wt-5' }])
  })

  it('normalizes the tracked frame.page to the clamped value even when the click resolves to nothing', () => {
    const frame: WorktreeListFrame = {
      screen: 'worktreeList',
      hostId: 'h1',
      selectedIndex: 20,
      page: 1
    }
    const ctx = fixtureCtx({ worktreeCount: () => 20, worktreeListPageCount: () => 1 })
    const { state } = reduceWorktreeListSelect(stateOf(frame), ctx, frame, 5, undefined)
    expect(state.stack.at(-1)).toMatchObject({ page: 0, selectedIndex: 5 })
  })

  it('still applies the real page offset when the row set has not shrunk', () => {
    const frame: WorktreeListFrame = {
      screen: 'worktreeList',
      hostId: 'h1',
      selectedIndex: 20,
      page: 1
    }
    const ctx = fixtureCtx({
      worktreeCount: () => 25,
      worktreeListPageCount: () => 2,
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === 21 ? 'wt-21' : null)
    })
    const { state, effects } = reduceWorktreeListSelect(stateOf(frame), ctx, frame, 1, undefined)
    expect(state.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-21',
      terminalId: '',
      page: 0
    })
    expect(effects).toEqual([{ kind: 'openTerminalTail', worktreeId: 'wt-21' }])
  })

  it('resolves the item-0 quirk (-1 index + label) with the clamped page offset applied', () => {
    // Tracked page is stale (2, from before the shrink); the real click was on the now-only page.
    const frame: WorktreeListFrame = {
      screen: 'worktreeList',
      hostId: 'h1',
      selectedIndex: 5,
      page: 2
    }
    const ctx = fixtureCtx({
      worktreeCount: () => 20,
      worktreeListPageCount: () => 1,
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === 0 ? 'wt-0' : null)
    })
    const { state } = reduceWorktreeListSelect(stateOf(frame), ctx, frame, -1, 'first')
    expect(state.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-0',
      terminalId: '',
      page: 0
    })
  })

  it('index -1 without a label still fails closed (ignored), unaffected by the clamp', () => {
    const frame: WorktreeListFrame = {
      screen: 'worktreeList',
      hostId: 'h1',
      selectedIndex: 5,
      page: 1
    }
    const input = stateOf(frame)
    const ctx = fixtureCtx({ worktreeCount: () => 20, worktreeListPageCount: () => 1 })
    const { state, effects } = reduceWorktreeListSelect(input, ctx, frame, -1, undefined)
    expect(state).toBe(input)
    expect(effects).toEqual([])
  })
})
