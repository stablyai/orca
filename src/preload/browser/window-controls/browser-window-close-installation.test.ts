import { afterEach, describe, expect, it, vi } from 'vitest'

import { installBrowserWindowCloseGuard } from './browser-window-close-installation'

describe('browser window close guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('replaces the native close with a non-replaceable request to Orca', () => {
    const nativeClose = vi.fn()
    const requestClose = vi.fn()
    vi.stubGlobal('window', { close: nativeClose })

    installBrowserWindowCloseGuard(requestClose)

    expect(window.close()).toBeUndefined()
    expect(nativeClose).not.toHaveBeenCalled()
    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(Reflect.set(window, 'close', nativeClose)).toBe(false)
  })
})
