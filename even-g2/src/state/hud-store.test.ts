import { describe, expect, it, vi } from 'vitest'
import { createHudStore, type HudState } from './hud-store'

function fixtureState(): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askAnswered: null,
    nav: { stack: [{ screen: 'pairing' }], exitDialogArmed: false }
  }
}

describe('createHudStore', () => {
  it('subscribe fires with the new state on update', () => {
    const store = createHudStore(fixtureState())
    const listener = vi.fn()
    store.subscribe(listener)

    store.update((state) => ({ ...state, device: { connected: true } }))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(store.getState())
    expect(store.getState().device).toEqual({ connected: true })
  })

  it('unsubscribe stops further notifications', () => {
    const store = createHudStore(fixtureState())
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    unsubscribe()

    store.update((state) => ({ ...state, device: { connected: true } }))

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not notify when update returns the same state reference', () => {
    const store = createHudStore(fixtureState())
    const listener = vi.fn()
    store.subscribe(listener)

    store.update((state) => state)

    expect(listener).not.toHaveBeenCalled()
  })
})
