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
      stack: [{ screen: 'dashboard', hostId: 'host-1', page: 0 }],
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
      { screen: 'dashboard', hostId: 'h1', page: 0 }
    )
    const { state: next, effects } = reduceHudInput(state, { kind: 'doubleClick' }, fixtureCtx())
    expect(next.stack).toEqual([{ screen: 'hostList', selectedIndex: 0 }])
    expect(effects).toEqual([])
  })

  it('listSelect on hostList pushes dashboard + connectHost effect', () => {
    const state = stateOf({ screen: 'hostList', selectedIndex: 0 })
    const ctx = fixtureCtx({ hostIdAt: (i) => (i === 2 ? 'host-2' : null) })
    const { state: next, effects } = reduceHudInput(state, { kind: 'listSelect', index: 2 }, ctx)
    expect(next.stack.at(-1)).toEqual({ screen: 'dashboard', hostId: 'host-2', page: 0 })
    expect(effects).toEqual([{ kind: 'connectHost', hostId: 'host-2' }])
  })

  it('listSelect on worktreeList pushes terminalTail + openTerminalTail effect', () => {
    const state = stateOf(
      { screen: 'dashboard', hostId: 'h1', page: 0 },
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

  it('listSelect index -1 substitutes the frame`s own tracked selection', () => {
    const state = stateOf({ screen: 'hostList', selectedIndex: 3 })
    const ctx = fixtureCtx({ hostIdAt: (i) => (i === 3 ? 'host-3' : null) })
    const { state: next } = reduceHudInput(state, { kind: 'listSelect', index: -1 }, ctx)
    expect(next.stack.at(-1)).toEqual({ screen: 'dashboard', hostId: 'host-3', page: 0 })
  })

  it('doubleClick out of terminalTail also emits closeTerminalTail when a terminal is resolved', () => {
    const state = stateOf(
      { screen: 'dashboard', hostId: 'h1', page: 0 },
      { screen: 'terminalTail', hostId: 'h1', worktreeId: 'wt-1', terminalId: 'term-1', page: 0 }
    )
    const { state: next, effects } = reduceHudInput(state, { kind: 'doubleClick' }, fixtureCtx())
    expect(next.stack).toEqual([{ screen: 'dashboard', hostId: 'h1', page: 0 }])
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

  it('foregroundEnter while armed = dialogue shown -> refreshDashboard, stays armed', () => {
    const { state: next, effects } = reduceHudInput(
      armed,
      { kind: 'foregroundEnter' },
      fixtureCtx()
    )
    expect(effects).toEqual([{ kind: 'refreshDashboard' }])
    expect(next.exitDialogArmed).toBe(true)
  })

  it('foregroundExit while armed = user cancelled -> disarm + resumePolling', () => {
    const { state: next, effects } = reduceHudInput(armed, { kind: 'foregroundExit' }, fixtureCtx())
    expect(effects).toEqual([{ kind: 'resumePolling' }])
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
        { screen: 'dashboard', hostId: 'h1', page: 0 },
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

  it('abnormalExit tears down subscriptions but keeps state unchanged', () => {
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
    expect(next).toBe(withTail)
    expect(effects).toEqual([
      { kind: 'pausePolling' },
      { kind: 'closeTerminalTail', terminalId: 'term-2' }
    ])
  })
})

describe('scroll semantics per layout', () => {
  it('is a no-op on list layouts (firmware scrolls natively)', () => {
    const state = stateOf({ screen: 'hostList', selectedIndex: 0 })
    const { state: next, effects } = reduceHudInput(state, { kind: 'scrollNext' }, fixtureCtx())
    expect(next).toBe(state)
    expect(effects).toEqual([])
  })

  it('page-turns dashboard when it spans multiple pages', () => {
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', page: 0 })
    const ctx = fixtureCtx({ dashboardPageCount: () => 3 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollNext' }, ctx)
    expect(next.stack.at(-1)).toEqual({ screen: 'dashboard', hostId: 'h1', page: 1 })
  })

  it('moves a row cursor on dashboard when it fits on one page', () => {
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', page: 0 })
    const ctx = fixtureCtx({ dashboardPageCount: () => 1, worktreeCount: () => 4 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollNext' }, ctx)
    expect(next.stack.at(-1)).toEqual({ screen: 'dashboard', hostId: 'h1', page: 1 })
  })

  it('clamps dashboard cursor/page without wrapping', () => {
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', page: 0 })
    const ctx = fixtureCtx({ dashboardPageCount: () => 1, worktreeCount: () => 2 })
    const { state: next } = reduceHudInput(state, { kind: 'scrollPrev' }, ctx)
    expect(next).toBe(state)
  })

  it('page-turns terminalTail', () => {
    const state = stateOf(
      { screen: 'dashboard', hostId: 'h1', page: 0 },
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
      { screen: 'dashboard', hostId: 'h1', page: 0 },
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
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', page: 1 })
    const ctx = fixtureCtx({
      dashboardPageCount: () => 1,
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
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', page: 0 })
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
    const state = stateOf({ screen: 'dashboard', hostId: 'h1', page: 0 })
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
