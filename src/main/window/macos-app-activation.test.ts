import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createMacAppActivationHandler } from './macos-app-activation'

function makeWindow(options: { destroyed?: boolean; visible?: boolean } = {}): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    isVisible: vi.fn(() => options.visible ?? true)
  } as unknown as BrowserWindow
}

describe('createMacAppActivationHandler', () => {
  it('leaves an existing window to native macOS activation', () => {
    const requestActivation = vi.fn()
    const handler = createMacAppActivationHandler({
      getWindow: () => makeWindow(),
      isWindowReachable: () => true,
      requestActivation
    })

    handler()

    expect(requestActivation).not.toHaveBeenCalled()
  })

  it.each([null, makeWindow({ destroyed: true })])(
    'requests desktop activation for a missing or destroyed window',
    (window) => {
      const requestActivation = vi.fn()
      const handler = createMacAppActivationHandler({
        getWindow: () => window,
        isWindowReachable: () => true,
        requestActivation
      })

      handler()

      expect(requestActivation).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ['hidden', makeWindow({ visible: false }), true],
    ['offscreen', makeWindow(), false]
  ])('requests desktop activation for a live %s window', (_label, window, reachable) => {
    const requestActivation = vi.fn()
    const handler = createMacAppActivationHandler({
      getWindow: () => window as BrowserWindow,
      isWindowReachable: () => reachable as boolean,
      requestActivation
    })

    handler()

    expect(requestActivation).toHaveBeenCalledTimes(1)
  })
})
