import { afterEach, describe, expect, it, vi } from 'vitest'

import { installBrowserWindowCloseGuard } from './browser-window-close-installation'

describe('browser window close preload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('installs a non-replaceable window.close no-op in the page world', () => {
    const nativeClose = vi.fn()
    vi.stubGlobal('window', { close: nativeClose })

    installBrowserWindowCloseGuard()

    expect(window.close()).toBeUndefined()
    expect(window.close).not.toBe(nativeClose)
    expect(Reflect.set(window, 'close', nativeClose)).toBe(false)
  })
})
