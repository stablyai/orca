import { describe, expect, it } from 'vitest'
import type { HudState } from '../state/hud-store'
import { renderHostListScreen } from './host-list-screen'

function fixtureState(overrides: Partial<HudState> = {}): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    nav: { stack: [{ screen: 'hostList', selectedIndex: 0 }], exitDialogArmed: false },
    ...overrides
  }
}

const HOST_1 = {
  id: 'h1',
  name: 'desktop-1',
  endpoint: 'ws://a',
  deviceToken: 't',
  publicKeyB64: 'k',
  lastConnected: 0
}
const HOST_2 = {
  id: 'h2',
  name: 'desktop-2',
  endpoint: 'ws://b',
  deviceToken: 't',
  publicKeyB64: 'k',
  lastConnected: 0
}

describe('renderHostListScreen', () => {
  it('HIGH #3: shows the pairing instruction (not a fake click=open list) with 0 paired hosts', () => {
    const page = renderHostListScreen(fixtureState())
    expect(page).toEqual({
      layout: 'list',
      header: 'Orca · Pair on phone',
      items: ["Open Orca on your phone's Even app page to pair."],
      footer: '2tap=exit'
    })
  })

  it('marks the connected host ok and other hosts "not connected" (never a guessed "offline")', () => {
    const state = fixtureState({
      hosts: [HOST_1, HOST_2],
      connection: { hostId: 'h1', state: 'connected', compat: null }
    })
    const page = renderHostListScreen(state)
    expect(page.layout).toBe('list')
    if (page.layout !== 'list') {
      throw new Error('expected list layout')
    }
    expect(page.header).toBe('Orca · 2 hosts')
    expect(page.items).toEqual(['● desktop-1 — ok', '◇ desktop-2 — not connected'])
  })

  it('shows "connecting" (not "offline") for the currently-targeted host mid-handshake', () => {
    const state = fixtureState({
      hosts: [HOST_1],
      connection: { hostId: 'h1', state: 'connecting', compat: null }
    })
    const page = renderHostListScreen(state)
    expect(page.layout).toBe('list')
    if (page.layout !== 'list') {
      throw new Error('expected list layout')
    }
    expect(page.items).toEqual(['◇ desktop-1 — connecting'])
  })

  it('shows "offline" only for the currently-targeted host once it is actually known disconnected', () => {
    const state = fixtureState({
      hosts: [HOST_1],
      connection: { hostId: 'h1', state: 'disconnected', compat: null }
    })
    const page = renderHostListScreen(state)
    expect(page.layout).toBe('list')
    if (page.layout !== 'list') {
      throw new Error('expected list layout')
    }
    expect(page.items).toEqual(['◇ desktop-1 — offline'])
  })
})
