import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createMacAppActivationHandler } from './macos-app-activation'

function makeWindow(destroyed = false): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => destroyed)
  } as unknown as BrowserWindow
}

describe('createMacAppActivationHandler', () => {
  it('leaves an existing window to native macOS activation', () => {
    const requestActivation = vi.fn()
    const handler = createMacAppActivationHandler({
      getWindow: () => makeWindow(),
      requestActivation
    })

    handler()

    expect(requestActivation).not.toHaveBeenCalled()
  })

  it.each([null, makeWindow(true)])(
    'requests desktop activation for a missing or destroyed window',
    (window) => {
      const requestActivation = vi.fn()
      const handler = createMacAppActivationHandler({
        getWindow: () => window,
        requestActivation
      })

      handler()

      expect(requestActivation).toHaveBeenCalledTimes(1)
    }
  )
})
