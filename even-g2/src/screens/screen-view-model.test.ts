import { describe, expect, it } from 'vitest'
import type { HudState } from '../state/hud-store'
import type { NavState } from '../navigation/nav-contract'
import { renderScreen } from './screen-view-model'

function fixtureState(nav: NavState): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    nav
  }
}

describe('renderScreen', () => {
  it('short-circuits to the block screen on a blocked compat verdict for the connected host', () => {
    const state = fixtureState({
      stack: [{ screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 }],
      exitDialogArmed: false
    })
    state.connection = {
      hostId: 'h1',
      state: 'connected',
      compat: { kind: 'blocked', reason: 'desktop-too-old', desktopVersion: 1 }
    }
    const page = renderScreen(state)
    expect(page.header).toBe('Version mismatch')
    if (page.layout !== 'text') {
      throw new Error('expected text layout')
    }
    expect(page.body).toContain('Update Orca on the desktop')
  })

  it('does not block when compat is blocked but no host is connected', () => {
    const state = fixtureState({ stack: [{ screen: 'pairing' }], exitDialogArmed: false })
    state.connection = {
      hostId: null,
      state: 'disconnected',
      compat: { kind: 'blocked', reason: 'mobile-too-old', desktopVersion: 3 }
    }
    expect(renderScreen(state).header).toBe('Orca · Pair on phone')
  })

  it('dispatches to the pairing screen', () => {
    const page = renderScreen(
      fixtureState({ stack: [{ screen: 'pairing' }], exitDialogArmed: false })
    )
    expect(page.header).toBe('Orca · Pair on phone')
  })

  it('dispatches to the host list screen', () => {
    const state = fixtureState({
      stack: [{ screen: 'hostList', selectedIndex: 0 }],
      exitDialogArmed: false
    })
    // HIGH #3: with 1+ paired hosts, host-list-screen shows a real "N hosts" header (not the
    // 0-host pairing prompt, which is indistinguishable from pairing-screen's own header).
    state.hosts = [
      {
        id: 'h1',
        name: 'Dev',
        endpoint: 'memory://h1',
        deviceToken: 'token',
        publicKeyB64: 'key',
        lastConnected: 0
      }
    ]
    const page = renderScreen(state)
    expect(page.layout).toBe('list')
    expect(page.header).toBe('Orca · 1 host')
  })

  it('dispatches to the dashboard screen (the top of the stack, not the root)', () => {
    const state = fixtureState({
      stack: [
        { screen: 'hostList', selectedIndex: 0 },
        { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 }
      ],
      exitDialogArmed: false
    })
    // HIGH #3: dashboard-screen branches on connection + poll freshness — a live, polled
    // connection with 0 rows must not render as the host-list/pairing screen's header.
    state.connection = { hostId: 'h1', state: 'connected', compat: null }
    state.dashboard = { rows: [], fetchedAt: 1, stale: false }
    const page = renderScreen(state)
    expect(page.header).toBe('Orca · 0 running · 1/1')
    expect(page.layout).toBe('text')
    if (page.layout === 'text') {
      expect(page.body).toBe('No worktrees')
    }
  })

  it('dispatches to the worktree list screen', () => {
    const page = renderScreen(
      fixtureState({
        stack: [
          { screen: 'dashboard', hostId: 'h1', cursor: 0, page: 0 },
          { screen: 'worktreeList', hostId: 'h1', selectedIndex: 0, page: 0 }
        ],
        exitDialogArmed: false
      })
    )
    expect(page.layout).toBe('list')
    expect(page.header).toMatch(/^Worktrees/)
  })

  it('dispatches to the ask screen', () => {
    const page = renderScreen(
      fixtureState({
        stack: [{ screen: 'ask', hostId: 'h1', notificationId: 'n1', selectedOption: 0 }],
        exitDialogArmed: false
      })
    )
    expect(page.footer).toBe('scroll=choose  click=send  2tap=back')
  })

  it('dispatches to the terminal tail screen', () => {
    const page = renderScreen(
      fixtureState({
        stack: [
          { screen: 'terminalTail', hostId: 'h1', worktreeId: 'wt-1', terminalId: '', page: 0 }
        ],
        exitDialogArmed: false
      })
    )
    expect(page.header).toMatch(/^term ·/)
  })
})
