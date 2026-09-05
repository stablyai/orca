import { describe, expect, it } from 'vitest'
import { createInitialNavState, reduceHudInput } from './hud-navigation'
import type { NavContext, NavState } from './nav-contract'

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
    ...overrides
  }
}

function stateOf(...stack: NavState['stack']): NavState {
  return { stack, exitDialogArmed: false }
}

describe('createInitialNavState', () => {
  it('roots at dashboard when exactly one host is known', () => {
    const state = createInitialNavState([{ id: 'host-1' }])
    expect(state).toEqual({
      stack: [{ screen: 'dashboard', hostId: 'host-1', cursor: 0, page: 0 }],
      exitDialogArmed: false
    })
  })

  it('roots at hostList otherwise (0 or 2+ hosts)', () => {
    expect(createInitialNavState([]).stack).toEqual([{ screen: 'hostList', selectedIndex: 0 }])
    expect(createInitialNavState([{ id: 'a' }, { id: 'b' }]).stack).toEqual([
      { screen: 'hostList', selectedIndex: 0 }
    ])
  })
})

describe('stack push/pop', () => {
  it('doubleClick pops one frame when not at root', () => {
    const state = stateOf(
      { screen: 'hostList', selectedIndex: 0 },
      { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 }
    )
    const { state: next, effects } = reduceHudInput(state, { kind: 'doubleClick' }, fixtureCtx())
    expect(next.stack).toEqual([{ screen: 'hostList', selectedIndex: 0 }])
    expect(effects).toEqual([])
  })

  it('listSelect on hostList pushes dashboard + connectHost effect', () => {
    const state = stateOf({ screen: 'hostList', selectedIndex: 0 })
    const ctx = fixtureCtx({ hostIdAt: (i) => (i === 2 ? 'host-2' : null) })
    const { state: next, effects } = reduceHudInput(state, { kind: 'listSelect', index: 2 }, ctx)
    expect(next.stack.at(-1)).toEqual({ screen: 'dashboard', hostId: 'host-2', cursor: 0, page: 0 })
    expect(effects).toEqual([{ kind: 'connectHost', hostId: 'host-2' }])
  })

  it('listSelect on worktreeList pushes terminalTail + openTerminalTail effect', () => {
    const state = stateOf(
      { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 },
      { screen: 'worktreeList', hostId: 'h1', selectedIndex: 0, page: 0 }
    )
    const ctx = fixtureCtx({
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === 1 ? 'wt-1' : null)
    })
    const { state: next, effects } = reduceHudInput(state, { kind: 'listSelect', index: 1 }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-1',
      terminalId: '',
      page: 0
    })
    expect(effects).toEqual([{ kind: 'openTerminalTail', worktreeId: 'wt-1' }])
  })

  it('listSelect index -1 with a label resolves to item 0 (SDK quirk), never a stale tracked cursor', () => {
    // Tracked selection is 3 (stale, e.g. from before a list rebuild); firmware's item-0 click
    // quirk must still resolve to item 0, not to the stale cursor.
    const state = stateOf({ screen: 'hostList', selectedIndex: 3 })
    const ctx = fixtureCtx({ hostIdAt: (i) => (i === 0 ? 'host-0' : null) })
    const { state: next } = reduceHudInput(
      state,
      { kind: 'listSelect', index: -1, label: 'first' },
      ctx
    )
    expect(next.stack.at(-1)).toEqual({ screen: 'dashboard', hostId: 'host-0', cursor: 0, page: 0 })
  })

  it('listSelect index -1 without a label fails closed (ignored) rather than guessing', () => {
    const state = stateOf({ screen: 'hostList', selectedIndex: 3 })
    const ctx = fixtureCtx({ hostIdAt: (i) => (i === 3 ? 'host-3' : null) })
    const { state: next, effects } = reduceHudInput(state, { kind: 'listSelect', index: -1 }, ctx)
    expect(next).toBe(state)
    expect(effects).toEqual([])
  })

  it('doubleClick out of terminalTail also emits closeTerminalTail when a terminal is resolved', () => {
    const state = stateOf(
      { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 },
      { screen: 'terminalTail', hostId: 'h1', worktreeId: 'wt-1', terminalId: 'term-1', page: 0 }
    )
    const { state: next, effects } = reduceHudInput(state, { kind: 'doubleClick' }, fixtureCtx())
    expect(next.stack).toEqual([{ screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 }])
    expect(effects).toEqual([{ kind: 'closeTerminalTail', terminalId: 'term-1' }])
  })
})

describe('root double-tap', () => {
  it('emits requestShutdownDialog and arms the exit dialogue instead of popping', () => {
    const state = stateOf({ screen: 'hostList', selectedIndex: 0 })
    const { state: next, effects } = reduceHudInput(state, { kind: 'doubleClick' }, fixtureCtx())
    expect(next.stack).toEqual(state.stack)
    expect(next.exitDialogArmed).toBe(true)
    expect(effects).toEqual([{ kind: 'requestShutdownDialog' }])
  })
})

describe('exit-dialogue polarity', () => {
  const armed: NavState = {
    stack: [{ screen: 'hostList', selectedIndex: 0 }],
    exitDialogArmed: true
  }

  it('foregroundEnter while armed = dialogue shown -> refreshDashboard + invalidateRender, stays armed', () => {
    // Firmware clears the page to show the dialogue; the render queue must be invalidated too,
    // or a later render with unchanged content is diffed as a no-op and the HUD stays blank.
    const { state: next, effects } = reduceHudInput(
      armed,
      { kind: 'foregroundEnter' },
      fixtureCtx()
    )
    expect(effects).toEqual([{ kind: 'refreshDashboard' }, { kind: 'invalidateRender' }])
    expect(next.exitDialogArmed).toBe(true)
  })

  it('foregroundExit while armed = user cancelled -> disarm + invalidateRender + resumePolling', () => {
    const { state: next, effects } = reduceHudInput(armed, { kind: 'foregroundExit' }, fixtureCtx())
    expect(effects).toEqual([{ kind: 'invalidateRender' }, { kind: 'resumePolling' }])
    expect(next.exitDialogArmed).toBe(false)
  })

  it('systemExit while armed = really exiting -> teardown effects, disarms', () => {
    const { state: next, effects } = reduceHudInput(armed, { kind: 'systemExit' }, fixtureCtx())
    expect(effects).toEqual([{ kind: 'pausePolling' }, { kind: 'disconnectHost' }])
    expect(next.exitDialogArmed).toBe(false)
  })

  it('systemExit closes any open terminal tail and disconnects the host as part of teardown', () => {
    const withTail: NavState = {
      stack: [
        { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 },
        { screen: 'terminalTail', hostId: 'h1', worktreeId: 'wt-1', terminalId: 'term-9', page: 0 }
      ],
      exitDialogArmed: true
    }
    const { effects } = reduceHudInput(withTail, { kind: 'systemExit' }, fixtureCtx())
    expect(effects).toEqual([
      { kind: 'pausePolling' },
      { kind: 'closeTerminalTail', terminalId: 'term-9' },
      { kind: 'disconnectHost' }
    ])
  })

  it('outside the armed window, foreground events have normal pause/resume meaning', () => {
    const unarmed = stateOf({ screen: 'hostList', selectedIndex: 0 })
    expect(reduceHudInput(unarmed, { kind: 'foregroundEnter' }, fixtureCtx()).effects).toEqual([
      { kind: 'resumePolling' }
    ])
    expect(reduceHudInput(unarmed, { kind: 'foregroundExit' }, fixtureCtx()).effects).toEqual([
      { kind: 'pausePolling' }
    ])
  })

  it('abnormalExit tears down subscriptions and marks retained terminal tails for reopen', () => {
    const withTail: NavState = {
      stack: [
        { screen: 'terminalTail', hostId: 'h1', worktreeId: 'wt-1', terminalId: 'term-2', page: 0 }
      ],
      exitDialogArmed: false
    }
    const { state: next, effects } = reduceHudInput(
      withTail,
      { kind: 'abnormalExit' },
      fixtureCtx()
    )
    expect(next.stack).toEqual(withTail.stack)
    expect(next.terminalTailsNeedReopen).toBe(true)
    expect(effects).toEqual([
      { kind: 'pausePolling' },
      { kind: 'closeTerminalTail', terminalId: 'term-2' }
    ])
  })

  it('abnormalExit with no terminal tail on the stack leaves state unchanged', () => {
    const withoutTail = stateOf({ screen: 'hostList', selectedIndex: 0 })
    const { state: next } = reduceHudInput(withoutTail, { kind: 'abnormalExit' }, fixtureCtx())
    expect(next).toBe(withoutTail)
  })

  it('foregroundEnter after an abnormalExit reopens every retained terminal-tail frame', () => {
    const state: NavState = {
      stack: [
        { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 },
        { screen: 'terminalTail', hostId: 'h1', worktreeId: 'wt-1', terminalId: 'term-2', page: 0 }
      ],
      exitDialogArmed: false,
      terminalTailsNeedReopen: true
    }
    const { state: next, effects } = reduceHudInput(
      state,
      { kind: 'foregroundEnter' },
      fixtureCtx()
    )
    expect(effects).toEqual([
      { kind: 'resumePolling' },
      { kind: 'reopenTerminalTail', worktreeId: 'wt-1' }
    ])
    expect(next.terminalTailsNeedReopen).toBe(false)
  })

  it('foregroundEnter without a pending reopen has the normal resumePolling-only effect', () => {
    const state: NavState = {
      stack: [{ screen: 'hostList', selectedIndex: 0 }],
      exitDialogArmed: false
    }
    const { effects } = reduceHudInput(state, { kind: 'foregroundEnter' }, fixtureCtx())
    expect(effects).toEqual([{ kind: 'resumePolling' }])
  })
})

describe('scroll semantics per layout', () => {
  it('is a no-op on list layouts (firmware scrolls natively)', () => {
    const state = stateOf({ screen: 'hostList', selectedIndex: 0 })
    const { state: next, effects } = reduceHudInput(state, { kind: 'scrollNext' }, fixtureCtx())
    expect(next).toBe(state)
    expect(effects).toEqual([])
  })

  it('page-turns dashboard when it spans multiple pages, cursor untouched', () => {
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 })
    const ctx = fixtureCtx({ dashboardPageCount: () => 3 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollNext' }, ctx)
    expect(next.stack.at(-1)).toEqual({ screen: 'dashboard', hostId: 'h1', cursor: 0, page: 1 })
  })

  it('moves a row cursor (not the page) on dashboard when it fits on one page', () => {
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 })
    const ctx = fixtureCtx({ dashboardPageCount: () => 1, worktreeCount: () => 4 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollNext' }, ctx)
    expect(next.stack.at(-1)).toEqual({ screen: 'dashboard', hostId: 'h1', cursor: 1, page: 0 })
  })

  it('clamps a dashboard cursor left stale by a row-set shrink before resolving a click', () => {
    // Cursor was tracking row 2 of a 3-row dashboard; a poll shrinks it to 2 rows. The stale
    // cursor must be clamped to a valid row before being used to resolve the click, not passed
    // through raw (which would silently look up a row that no longer exists).
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', cursor: 2, page: 0 })
    const ctx = fixtureCtx({
      dashboardPageCount: () => 1,
      worktreeCount: () => 2,
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === 1 ? 'wt-last' : null)
    })
    const { state: next, effects } = reduceHudInput(state, { kind: 'click' }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-last',
      terminalId: '',
      page: 0
    })
    expect(effects).toEqual([{ kind: 'openTerminalTail', worktreeId: 'wt-last' }])
  })

  it('clamps dashboard cursor/page without wrapping', () => {
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 })
    const ctx = fixtureCtx({ dashboardPageCount: () => 1, worktreeCount: () => 2 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollPrev' }, ctx)
    expect(next).toBe(state)
  })

  it('page-turns terminalTail', () => {
    const state = stateOf(
      { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 },
      { screen: 'terminalTail', hostId: 'h1', worktreeId: 'wt-1', terminalId: 'term-1', page: 0 }
    )
    const ctx = fixtureCtx({ terminalTailPageCount: () => 2 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollNext' }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-1',
      terminalId: 'term-1',
      page: 1
    })
  })

  it('moves the ask option cursor', () => {
    const state = stateOf(
      { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 },
      { screen: 'ask', hostId: 'h1', notificationId: 'n1', selectedOption: 0 }
    )
    const ctx = fixtureCtx({ askOptionCount: () => 3 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollNext' }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'ask',
      hostId: 'h1',
      notificationId: 'n1',
      selectedOption: 1
    })
  })
})

describe('ask cursor + sendAskAnswer', () => {
  it('click sends the highlighted option digit', () => {
    const state = stateOf({ screen: 'ask', hostId: 'h1', notificationId: 'n1', selectedOption: 1 })
    const ctx = fixtureCtx({ askOptionCount: () => 3, notificationWorktreeId: () => 'wt-1' })
    const { effects } = reduceHudInput(state, { kind: 'click' }, ctx)
    expect(effects).toEqual([
      {
        kind: 'sendAskAnswer',
        hostId: 'h1',
        worktreeId: 'wt-1',
        option: { kind: 'option', digit: 2 }
      }
    ])
  })

  it('click at the Enter slot sends enter', () => {
    const state = stateOf({ screen: 'ask', hostId: 'h1', notificationId: 'n1', selectedOption: 3 })
    const ctx = fixtureCtx({ askOptionCount: () => 3, notificationWorktreeId: () => 'wt-1' })
    const { effects } = reduceHudInput(state, { kind: 'click' }, ctx)
    expect(effects).toEqual([
      { kind: 'sendAskAnswer', hostId: 'h1', worktreeId: 'wt-1', option: { kind: 'enter' } }
    ])
  })

  it('click at the Esc slot sends escape', () => {
    const state = stateOf({ screen: 'ask', hostId: 'h1', notificationId: 'n1', selectedOption: 4 })
    const ctx = fixtureCtx({ askOptionCount: () => 3, notificationWorktreeId: () => 'wt-1' })
    const { effects } = reduceHudInput(state, { kind: 'click' }, ctx)
    expect(effects).toEqual([
      { kind: 'sendAskAnswer', hostId: 'h1', worktreeId: 'wt-1', option: { kind: 'escape' } }
    ])
  })

  it('is a no-op if the notification`s worktree cannot be resolved', () => {
    const state = stateOf({ screen: 'ask', hostId: 'h1', notificationId: 'n1', selectedOption: 0 })
    const { state: next, effects } = reduceHudInput(state, { kind: 'click' }, fixtureCtx())
    expect(next).toBe(state)
    expect(effects).toEqual([])
  })
})

describe('dashboard click', () => {
  it('drills into the highlighted worktree when the dashboard fits on one page', () => {
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', cursor: 1, page: 0 })
    const ctx = fixtureCtx({
      dashboardPageCount: () => 1,
      worktreeCount: () => 2,
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === 1 ? 'wt-2' : null)
    })
    const { state: next, effects } = reduceHudInput(state, { kind: 'click' }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-2',
      terminalId: '',
      page: 0
    })
    expect(effects).toEqual([{ kind: 'openTerminalTail', worktreeId: 'wt-2' }])
  })

  it('opens worktreeList instead when the dashboard spans multiple pages', () => {
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 })
    const ctx = fixtureCtx({ dashboardPageCount: () => 2 })
    const { state: next, effects } = reduceHudInput(state, { kind: 'click' }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'worktreeList',
      hostId: 'h1',
      selectedIndex: 0,
      page: 0
    })
    expect(effects).toEqual([])
  })

  it('a pending ask notification takes priority over the drill/list click', () => {
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 })
    const ctx = fixtureCtx({
      dashboardPageCount: () => 2,
      pendingAskNotificationId: (hostId) => (hostId === 'h1' ? 'n-pending' : null)
    })
    const { state: next, effects } = reduceHudInput(state, { kind: 'click' }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'ask',
      hostId: 'h1',
      notificationId: 'n-pending',
      selectedOption: 0
    })
    expect(effects).toEqual([])
  })
})

describe('worktreeList pagination (>20 worktrees)', () => {
  it('scrolling next at the bottom boundary of the first page turns to page 1, landing on its first item', () => {
    const state = stateOf({ screen: 'worktreeList', hostId: 'h1', selectedIndex: 19, page: 0 })
    const ctx = fixtureCtx({ worktreeListPageCount: () => 2, worktreeCount: () => 25 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollNext' }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'worktreeList',
      hostId: 'h1',
      selectedIndex: 20,
      page: 1
    })
  })

  it('scrolling prev from page 1 turns back to page 0, landing on its last item', () => {
    const state = stateOf({ screen: 'worktreeList', hostId: 'h1', selectedIndex: 20, page: 1 })
    const ctx = fixtureCtx({ worktreeListPageCount: () => 2, worktreeCount: () => 25 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollPrev' }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'worktreeList',
      hostId: 'h1',
      selectedIndex: 19,
      page: 0
    })
  })

  it('does not turn the page past the last one', () => {
    const state = stateOf({ screen: 'worktreeList', hostId: 'h1', selectedIndex: 20, page: 1 })
    const ctx = fixtureCtx({ worktreeListPageCount: () => 2, worktreeCount: () => 25 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollNext' }, ctx)
    expect(next).toBe(state)
  })

  it('resolves a page-1 listSelect click as page * pageSize + localIndex, not the raw local index', () => {
    const state = stateOf({ screen: 'worktreeList', hostId: 'h1', selectedIndex: 20, page: 1 })
    const ctx = fixtureCtx({
      worktreeCount: () => 25,
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === 21 ? 'wt-21' : null)
    })
    const { state: next, effects } = reduceHudInput(state, { kind: 'listSelect', index: 1 }, ctx)
    expect(next.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-21',
      terminalId: '',
      page: 0
    })
    expect(effects).toEqual([{ kind: 'openTerminalTail', worktreeId: 'wt-21' }])
  })

  it('resolves page-0 item-0 quirk (-1 index) with the page offset still applied', () => {
    const state = stateOf({ screen: 'worktreeList', hostId: 'h1', selectedIndex: 5, page: 0 })
    const ctx = fixtureCtx({
      worktreeCount: () => 25,
      worktreeIdAt: (hostId, i) => (hostId === 'h1' && i === 0 ? 'wt-0' : null)
    })
    const { state: next } = reduceHudInput(
      state,
      { kind: 'listSelect', index: -1, label: 'first' },
      ctx
    )
    expect(next.stack.at(-1)).toEqual({
      screen: 'terminalTail',
      hostId: 'h1',
      worktreeId: 'wt-0',
      terminalId: '',
      page: 0
    })
  })
})
