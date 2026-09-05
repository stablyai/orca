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
    askAnswered: null,
    nav: { stack: [{ screen: 'hostList', selectedIndex: 0 }], exitDialogArmed: false },
    ...overrides
  }
}

describe('renderHostListScreen', () => {
  it('shows a placeholder row when there are no paired hosts', () => {
    const page = renderHostListScreen(fixtureState())
    expect(page).toEqual({
      layout: 'list',
      header: 'Orca · 0 hosts',
      items: ['No paired hosts'],
      footer: 'click=open  2tap=exit'
    })
  })

  it('marks the connected host with the online glyph and the rest offline', () => {
    const state = fixtureState({
      hosts: [
        {
          id: 'h1',
          name: 'desktop-1',
          endpoint: 'ws://a',
          deviceToken: 't',
          publicKeyB64: 'k',
          lastConnected: 0
        },
        {
          id: 'h2',
          name: 'desktop-2',
          endpoint: 'ws://b',
          deviceToken: 't',
          publicKeyB64: 'k',
          lastConnected: 0
        }
      ],
      connection: { hostId: 'h1', state: 'connected', compat: null }
    })
    const page = renderHostListScreen(state)
    expect(page.layout).toBe('list')
    if (page.layout !== 'list') {
      throw new Error('expected list layout')
    }
    expect(page.header).toBe('Orca · 2 hosts')
    expect(page.items).toEqual(['● desktop-1 — ok', '◇ desktop-2 — offline'])
  })
})
