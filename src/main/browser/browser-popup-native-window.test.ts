import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { events } = vi.hoisted(() => ({ events: new Map<string, (...args: unknown[]) => void>() }))
vi.mock('electron', () => ({
  app: {
    prependOnceListener: (name: string, listener: (...args: unknown[]) => void) =>
      events.set(name, listener),
    off: (name: string, listener: (...args: unknown[]) => void) => {
      if (events.get(name) === listener) {
        events.delete(name)
      }
    }
  }
}))

import {
  allowNativeBrowserPopup,
  isNativeBrowserPopupRequest,
  prepareNativeBrowserPopup
} from './browser-popup-native-window'

afterEach(() => {
  events.clear()
  vi.unstubAllEnvs()
})

function nativeWindow() {
  const contents = Object.assign(new EventEmitter(), {
    session: {},
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
  it('uses the native path only for observed unnamed, featureless OpenURL dispositions', () => {
    for (const disposition of ['new-window', 'background-tab']) {
      expect(isNativeBrowserPopupRequest({ disposition, features: '', frameName: '' })).toBe(true)
      expect(
        isNativeBrowserPopupRequest({ disposition, features: 'width=500', frameName: '' })
      ).toBe(false)
      expect(isNativeBrowserPopupRequest({ disposition, features: '', frameName: 'oauth' })).toBe(
        false
      )
    }
    for (const details of [
      { disposition: 'foreground-tab', features: '', frameName: '' },
      { disposition: 'new-window', features: 'width=500', frameName: '' },
      { disposition: 'new-window', features: '', frameName: 'oauth' },
      {}
    ]) {
      expect(isNativeBrowserPopupRequest(details)).toBe(false)
    }
  })

  it('leaves request continuation to Electron and expires an unused admission before the next turn', async () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    const opener = nativeWindow().browserWindow.webContents
    const onCreated = vi.fn()
    const response = allowNativeBrowserPopup({
      opener,
      targetUrl: 'https://example.com/post?code=synthetic',
      options: { show: true, frame: true },
      onCreated
    })
    expect(response.createWindow).toBeUndefined()
    expect(response.overrideBrowserWindowOptions).toMatchObject({
      show: false,
      fullscreenable: false,
      title: 'https://example.com',
      useContentSize: true,
      minWidth: 360,
      minHeight: 200,
      webPreferences: { session: opener.session }
    })
    expect(events.has('browser-window-created')).toBe(true)
    await Promise.resolve()
    expect(events.has('browser-window-created')).toBe(false)
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('admits the script-opened child its opener reports in a later task', async () => {
    const opener = nativeWindow()
    const linked = nativeWindow()
    const scripted = nativeWindow()
    linked.contents.session = opener.contents.session
    scripted.contents.session = opener.contents.session
    const onScripted = vi.fn(() => {
      prepareNativeBrowserPopup(scripted.browserWindow, 'https://example.com/scripted', () => true)
      return scripted.browserWindow.webContents
    })
    const admit = (onCreated: () => Electron.WebContents) =>
      allowNativeBrowserPopup({
        opener: opener.browserWindow.webContents,
        targetUrl: 'https://example.com/scripted',
        options: {},
        onCreated
      })
    const superseded = vi.fn(() => scripted.browserWindow.webContents)
    admit(superseded)
    await Promise.resolve()
    admit(onScripted)
    await Promise.resolve()
    // An OpenURL child admitted during its own turn must not consume the pending script admission.
    const onLinked = vi.fn(() => linked.browserWindow.webContents)
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      targetUrl: 'https://example.com/linked',
      options: {},
      onCreated: onLinked
    })
    events.get('browser-window-created')?.({}, linked.browserWindow)
    await Promise.resolve()
    opener.contents.emit('did-create-window', linked.browserWindow)
    expect(onLinked).toHaveBeenCalledOnce()
    expect(onScripted).not.toHaveBeenCalled()
    opener.contents.emit('did-create-window', scripted.browserWindow)
    expect(onScripted).toHaveBeenCalledWith(
      expect.objectContaining({ nativeWindow: scripted.browserWindow })
    )
    expect(superseded).not.toHaveBeenCalled()
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
      targetUrl: 'https://example.com/scripted',
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
        ? prepareNativeBrowserPopup(browserWindow, 'https://example.com/post', () => false)
            .contentWebContents
        : browserWindow.webContents
    )
    const response = allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      targetUrl: 'https://example.com/post',
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
    events.get('browser-window-created')?.({}, browserWindow)
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
    const popup = prepareNativeBrowserPopup(browserWindow, 'https://example.com/', prepare)
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

  it('protects the title and updates only main-frame origins, including redirects', () => {
    const { browserWindow, contents, window } = nativeWindow()
    prepareNativeBrowserPopup(browserWindow, 'https://example.com/post?code=synthetic', () => true)
    const preventDefault = vi.fn()
    window.emit('page-title-updated', { preventDefault }, 'Spoofed title')
    expect(preventDefault).toHaveBeenCalledOnce()
    contents.emit('did-start-navigation', {}, 'https://iframe.example.net/secret', false, false)
    expect(window.setTitle).toHaveBeenCalledTimes(1)
    contents.emit(
      'will-redirect',
      {},
      'https://destination.example.net/callback?token=synthetic',
      false,
      true
    )
    expect(window.setTitle).toHaveBeenCalledTimes(1)
    contents.emit('did-navigate', {}, 'https://destination.example.net/other')
    expect(window.setTitle).toHaveBeenLastCalledWith('https://destination.example.net')
  })
})
