import { describe, expect, it, vi } from 'vitest'
import { createServeDesktopActivationGate } from './serve-desktop-activation'

describe('createServeDesktopActivationGate', () => {
  it('coalesces activation requests while serve is initializing and drains once when ready', () => {
    const activateWindow = vi.fn()
    const gate = createServeDesktopActivationGate({
      initialState: 'initializing',
      activateWindow
    })

    gate.requestActivation()
    gate.requestActivation()

    expect(activateWindow).not.toHaveBeenCalled()
    expect(gate.getState()).toBe('initializing')

    gate.markReady()

    expect(activateWindow).toHaveBeenCalledOnce()
    expect(gate.getState()).toBe('ready')
  })

  it('activates immediately after the persistent provider is ready', () => {
    const activateWindow = vi.fn()
    const gate = createServeDesktopActivationGate({
      initialState: 'ready',
      activateWindow
    })

    gate.requestActivation()
    gate.requestActivation()

    expect(activateWindow).toHaveBeenCalledTimes(2)
  })

  it('drops pending activation and fails closed when promotion is blocked', () => {
    const activateWindow = vi.fn()
    const onBlocked = vi.fn()
    const gate = createServeDesktopActivationGate({
      initialState: 'initializing',
      activateWindow,
      onBlocked
    })

    gate.requestActivation()
    gate.markBlocked('persistent PTY provider unavailable')
    gate.requestActivation()

    expect(activateWindow).not.toHaveBeenCalled()
    expect(onBlocked).toHaveBeenCalledTimes(2)
    expect(gate.getState()).toBe('blocked')
  })
})
