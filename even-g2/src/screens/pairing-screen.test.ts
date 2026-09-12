import { describe, expect, it } from 'vitest'
import type { HudState } from '../state/hud-store'
import { renderPairingScreen } from './pairing-screen'

function fixtureState(overrides: Partial<HudState> = {}): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    nav: { stack: [{ screen: 'pairing' }], exitDialogArmed: false },
    ...overrides
  }
}

describe('renderPairingScreen', () => {
  it('prompts pairing on phone when disconnected', () => {
    expect(renderPairingScreen(fixtureState())).toEqual({
      layout: 'text',
      header: 'Orca · Pair on phone',
      body: "Open Orca on your phone's Even app page to pair.",
      footer: '2tap=exit'
    })
  })

  it('shows connecting feedback', () => {
    const state = fixtureState({ connection: { hostId: 'h1', state: 'connecting', compat: null } })
    expect(renderPairingScreen(state).body).toBe('Connecting to Orca…')
  })

  it('shows a rejected-pairing message on auth-failed', () => {
    const state = fixtureState({ connection: { hostId: 'h1', state: 'auth-failed', compat: null } })
    expect(renderPairingScreen(state).body).toBe('Pairing rejected. Re-pair on your phone.')
  })
})
