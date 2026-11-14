import { describe, expect, it, vi } from 'vitest'
import { createServeDesktopActivationGate } from './serve-desktop-activation'

describe('createServeDesktopActivationGate', () => {
  it('lets a queued user activation keep the foreground over a background open', () => {
    const activateWindow = vi.fn()
    const gate = createServeDesktopActivationGate({ initialState: 'initializing', activateWindow })

    gate.requestActivation({ background: true })
    gate.requestActivation()
    gate.requestActivation({ background: true })
    gate.markReady()

    expect(activateWindow.mock.calls).toEqual([[{ background: false }]])
  })
})
