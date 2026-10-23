import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBrowserWindowCloseRequest,
  installBrowserWindowCloseGuard
} from './browser-window-close-installation'
import { BROWSER_GUEST_WINDOW_CLOSE_CHANNEL } from '../shared/browser-guest-window-close'

describe('browser window close preload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('replaces window.close with a non-replaceable close request in the page world', () => {
    const nativeClose = vi.fn()
    const requestClose = vi.fn()
    vi.stubGlobal('window', { close: nativeClose })

    installBrowserWindowCloseGuard(requestClose)

    expect(window.close()).toBeUndefined()
    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(nativeClose).not.toHaveBeenCalled()
    expect(Reflect.set(window, 'close', nativeClose)).toBe(false)
    window.close()
    expect(requestClose).toHaveBeenCalledTimes(2)
  })

  it('asks the host to close only while the page holds a single history entry', () => {
    const sendToHost = vi.fn()
    const history = { length: 1 }
    vi.stubGlobal('window', { history })
    const requestClose = createBrowserWindowCloseRequest(sendToHost)

    requestClose()
    expect(sendToHost).toHaveBeenCalledWith(BROWSER_GUEST_WINDOW_CLOSE_CHANNEL)

    history.length = 2
    requestClose()
    expect(sendToHost).toHaveBeenCalledTimes(1)
  })
})
