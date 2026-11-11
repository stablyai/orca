import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNativeBrowserPopupWindow } from './native-browser-popup-windows'

const { events } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { events: new EventEmitter() }
})
vi.mock('electron', () => ({ app: events }))
import { allowNativeBrowserPopup, prepareNativeBrowserPopup } from './browser-popup-native-window'

afterEach(() => {
  events.removeAllListeners()
  vi.unstubAllEnvs()
})

function nativeWindow() {
  const contents = Object.assign(new EventEmitter(), {
    session: {},
    mainFrame: { url: '', origin: '' },
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    setWindowOpenHandler: vi.fn()
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    setTitle: vi.fn(),
    showInactive: vi.fn(),
    destroy: vi.fn()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements every BrowserWindow member exercised by popup preparation.
  const browserWindow = window as unknown as Electron.BrowserWindow
  return { window, contents, browserWindow }
}

describe('native popup admission', () => {
  it('admits the script-opened child its opener reports in a later task', async () => {
    const opener = nativeWindow()
    const linked = nativeWindow()
    const scripted = nativeWindow()
    linked.contents.session = opener.contents.session
    scripted.contents.session = opener.contents.session
    const onScripted = vi.fn(() => {
      prepareNativeBrowserPopup(scripted.browserWindow, () => true)
      return scripted.browserWindow.webContents
    })
    const admit = (onCreated: () => Electron.WebContents) =>
      allowNativeBrowserPopup({
        opener: opener.browserWindow.webContents,
        options: {},
        onCreated
      })
    admit(onScripted)
    await Promise.resolve()
    // OpenURL admission must leave the pending script admission intact.
    const onLinked = vi.fn(() => linked.browserWindow.webContents)
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: onLinked
    })
    events.emit('browser-window-created', {}, linked.browserWindow)
    await Promise.resolve()
    opener.contents.emit('did-create-window', linked.browserWindow)
    expect(onLinked).toHaveBeenCalledOnce()
    expect(onScripted).not.toHaveBeenCalled()
    opener.contents.emit('did-create-window', scripted.browserWindow)
    expect(onScripted).toHaveBeenCalledWith(
      expect.objectContaining({ nativeWindow: scripted.browserWindow })
    )
    const preventDefault = vi.fn()
    scripted.window.emit('page-title-updated', { preventDefault }, 'Spoofed title')
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('discards a native child its opener reports without a pending admission', async () => {
    const opener = nativeWindow()
    const first = nativeWindow()
    const unadmitted = nativeWindow()
    first.contents.session = opener.contents.session
    unadmitted.contents.session = opener.contents.session
    const onCreated = vi.fn(() => first.browserWindow.webContents)
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated
    })
    await Promise.resolve()
    opener.contents.emit('did-create-window', first.browserWindow)
    opener.contents.emit('did-create-window', unadmitted.browserWindow)
    expect(onCreated).toHaveBeenCalledOnce()
    expect(unadmitted.contents.close).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(unadmitted.window.destroy).toHaveBeenCalledOnce()
    expect(first.window.destroy).not.toHaveBeenCalled()
  })

  it('ignores a different-session app window without consuming the legitimate child admission', async () => {
    const opener = nativeWindow()
    const unrelated = nativeWindow()
    const child = nativeWindow()
    child.contents.session = opener.contents.session
    const onCreated = vi.fn(() => child.browserWindow.webContents)
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: { show: false },
      onCreated
    })
    events.emit('browser-window-created', {}, unrelated.browserWindow)
    expect(onCreated).not.toHaveBeenCalled()
    expect(isNativeBrowserPopupWindow(unrelated.browserWindow)).toBe(false)
    events.emit('browser-window-created', {}, child.browserWindow)
    await Promise.resolve()
    opener.contents.emit('did-create-window', child.browserWindow)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nativeWindow: child.browserWindow })
    )
    expect(isNativeBrowserPopupWindow(child.browserWindow)).toBe(true)
    expect(isNativeBrowserPopupWindow(unrelated.browserWindow)).toBe(false)
    expect(unrelated.contents.close).not.toHaveBeenCalled()
    expect(unrelated.window.destroy).not.toHaveBeenCalled()
    expect(child.contents.close).not.toHaveBeenCalled()
    expect(child.window.destroy).not.toHaveBeenCalled()
  })

  it.each([
    'ready',
    'background-launch',
    'explicit-hidden',
    'fenced',
    'authority-error',
    'closed',
    'opener-gone',
    'changed-launch',
    'changed-hidden',
    'changed-session',
    'preparation-rejected'
  ])('presents background children only after safe readiness: %s', (state) => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', state === 'background-launch' ? '1' : '0')
    const { browserWindow, window, contents } = nativeWindow()
    const opener = nativeWindow()
    contents.session = opener.contents.session
    const options = { show: state !== 'explicit-hidden' }
    const prepare = vi.fn(() =>
      state === 'preparation-rejected'
        ? prepareNativeBrowserPopup(browserWindow, () => false).contentWebContents
        : browserWindow.webContents
    )
    const response = allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options,
      background: true,
      canPresent: () => {
        if (state === 'authority-error') {
          throw new Error('Synthetic authority failure')
        }
        return state !== 'fenced'
      },
      onCreated: prepare
    })
    expect(response.overrideBrowserWindowOptions?.show).toBe(false)
    events.emit('browser-window-created', {}, browserWindow)
    expect(prepare).toHaveBeenCalledOnce()
    expect(window.showInactive).not.toHaveBeenCalled()
    if (state === 'closed') {
      window.isDestroyed.mockReturnValue(true)
    }
    if (state === 'opener-gone') {
      opener.contents.isDestroyed.mockReturnValue(true)
    }
    if (state === 'changed-launch') {
      vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    }
    if (state === 'changed-hidden') {
      options.show = false
    }
    if (state === 'changed-session') {
      contents.session = {}
    }
    window.emit('ready-to-show')
    expect(window.showInactive).toHaveBeenCalledTimes(state === 'ready' ? 1 : 0)
  })

  it.each([
    () => false,
    () => {
      throw new Error('Synthetic failed authority')
    }
  ])('blocks native navigation and descendants when preparation fails', (prepare) => {
    const { browserWindow, contents, window } = nativeWindow()
    const popup = prepareNativeBrowserPopup(browserWindow, prepare)
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      contents.emit(event, { preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    expect(contents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    expect(contents.close).toHaveBeenCalledOnce()
    window.emit('closed')
    const closed = vi.fn()
    popup.onClosed(closed)
    expect(closed).toHaveBeenCalledOnce()
  })

  it('initializes only from the committed frame and retains it through failed redirects', () => {
    const { browserWindow, contents, window } = nativeWindow()
    contents.mainFrame.url = 'https://committed.example/private?secret=synthetic'
    prepareNativeBrowserPopup(browserWindow)
    expect(window.setTitle).toHaveBeenLastCalledWith('https://committed.example')
    contents.emit('did-start-navigation', {}, 'https://requested.example/auth')
    contents.emit('will-redirect', {}, 'https://redirect.example/auth')
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://redirect.example/auth', true)
    contents.emit('did-finish-load')
    expect(window.setTitle).toHaveBeenLastCalledWith('https://committed.example')
    contents.mainFrame.url = 'chrome-error://chromewebdata/'
    contents.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://failed.example/',
      true
    )
    expect(window.setTitle).toHaveBeenLastCalledWith('chrome-error:')
  })
})
