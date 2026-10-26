import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { events } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { events: new EventEmitter() }
})
vi.mock('electron', () => ({ app: events }))

import {
  allowNativeBrowserPopup,
  isNativeBrowserPopupRequest,
  prepareNativeBrowserPopup
} from './browser-popup-native-window'

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
      options: { show: true, frame: true },
      onCreated
    })
    expect(response.createWindow).toBeUndefined()
    expect(response.overrideBrowserWindowOptions).toMatchObject({
      show: false,
      fullscreenable: false,
      title: 'about:blank',
      useContentSize: true,
      minWidth: 360,
      minHeight: 200,
      webPreferences: { session: opener.session }
    })
    expect(events.listenerCount('browser-window-created') > 0).toBe(true)
    await Promise.resolve()
    expect(events.listenerCount('browser-window-created') > 0).toBe(false)
    expect(onCreated).not.toHaveBeenCalled()
  })

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

  it.fails('KNOWN BLOCKER: a later scripted admission must not supersede the earlier request', async () => {
    const opener = nativeWindow()
    const first = nativeWindow()
    const second = nativeWindow()
    first.contents.session = opener.contents.session
    second.contents.session = opener.contents.session
    const earlier = vi.fn(() => first.browserWindow.webContents)
    const later = vi.fn(() => second.browserWindow.webContents)
    for (const onCreated of [earlier, later]) {
      allowNativeBrowserPopup({
        opener: opener.browserWindow.webContents,
        options: { show: false },
        onCreated
      })
      await Promise.resolve()
    }
    opener.contents.emit('did-create-window', second.browserWindow)
    opener.contents.emit('did-create-window', first.browserWindow)
    expect(later).toHaveBeenCalledWith(
      expect.objectContaining({ nativeWindow: second.browserWindow })
    )
    expect(earlier).toHaveBeenCalledWith(
      expect.objectContaining({ nativeWindow: first.browserWindow })
    )
  })

  it.fails('KNOWN BLOCKER: canceled A must not transfer B to a late child of A', async () => {
    const opener = nativeWindow()
    const lateA = nativeWindow()
    lateA.contents.session = opener.contents.session
    const onA = vi.fn(() => lateA.browserWindow.webContents)
    const onB = vi.fn(() => lateA.browserWindow.webContents)
    for (const onCreated of [onA, onB]) {
      allowNativeBrowserPopup({
        opener: opener.browserWindow.webContents,
        options: { show: false },
        onCreated
      })
      await Promise.resolve()
    }
    opener.contents.emit('did-create-window', lateA.browserWindow)
    expect(onB).not.toHaveBeenCalled()
  })

  it.fails('KNOWN BLOCKER: shared-session parents must not both prepare the same app notification', () => {
    const first = nativeWindow()
    const second = nativeWindow()
    const child = nativeWindow()
    second.contents.session = first.contents.session
    child.contents.session = first.contents.session
    const onFirst = vi.fn(() => child.browserWindow.webContents)
    const onSecond = vi.fn(() => child.browserWindow.webContents)
    for (const [opener, onCreated] of [
      [first.browserWindow.webContents, onFirst],
      [second.browserWindow.webContents, onSecond]
    ] as const) {
      allowNativeBrowserPopup({
        opener,
        options: { show: false },
        onCreated
      })
    }
    events.emit('browser-window-created', {}, child.browserWindow)
    expect(onSecond).toHaveBeenCalledOnce()
    expect(onFirst).not.toHaveBeenCalled()
  })

  it.fails.each([true, false])(
    'KNOWN BLOCKER: an unrelated app window receives neither policy nor disposal (same session: %s)',
    async (sameSession) => {
      const opener = nativeWindow()
      const unrelated = nativeWindow()
      if (sameSession) {
        unrelated.contents.session = opener.contents.session
      }
      const onCreated = vi.fn(() => unrelated.browserWindow.webContents)
      allowNativeBrowserPopup({
        opener: opener.browserWindow.webContents,
        options: { show: false },
        onCreated
      })
      events.emit('browser-window-created', {}, unrelated.browserWindow)
      await Promise.resolve()
      expect(onCreated).not.toHaveBeenCalled()
      expect(unrelated.contents.close).not.toHaveBeenCalled()
      expect(unrelated.window.destroy).not.toHaveBeenCalled()
    }
  )

  it('handles duplicate did-create-window delivery idempotently for an already marked child', async () => {
    const opener = nativeWindow()
    const child = nativeWindow()
    child.contents.session = opener.contents.session
    const onCreated = vi.fn(() => child.browserWindow.webContents)
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: { show: false },
      onCreated
    })
    await Promise.resolve()
    opener.contents.emit('did-create-window', child.browserWindow)
    opener.contents.emit('did-create-window', child.browserWindow)
    expect(onCreated).toHaveBeenCalledOnce()
    expect(child.contents.close).not.toHaveBeenCalled()
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

  it.each([1, 1000])(
    'ignores %i subframe failures but still updates main-frame errors',
    (count) => {
      const { browserWindow, contents, window } = nativeWindow()
      contents.mainFrame.url = 'https://committed.example/'
      contents.mainFrame.origin = 'https://committed.example'
      prepareNativeBrowserPopup(browserWindow)
      window.setTitle.mockClear()

      for (let index = 0; index < count; index += 1) {
        contents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://iframe.example/', false)
      }
      expect(window.setTitle).not.toHaveBeenCalled()

      contents.mainFrame.url = 'https://failed.example/'
      contents.mainFrame.origin = 'null'
      contents.emit('did-fail-load', {}, -2, 'ERR_FAILED', contents.mainFrame.url, true)
      expect(window.setTitle).toHaveBeenCalledExactlyOnceWith('unknown')
    }
  )

  it('uses a neutral title for an opaque network document and retains a surviving origin on abort', () => {
    const { browserWindow, contents, window } = nativeWindow()
    contents.mainFrame.url = 'https://committed.example/'
    contents.mainFrame.origin = 'https://committed.example'
    prepareNativeBrowserPopup(browserWindow)
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://failed.example/', true)
    expect(window.setTitle).toHaveBeenLastCalledWith('https://committed.example')
    contents.mainFrame.url = 'https://failed.example/'
    contents.mainFrame.origin = 'null'
    contents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://failed.example/', true)
    expect(window.setTitle).toHaveBeenLastCalledWith('unknown')
  })

  it('protects the title and updates only main-frame origins, including redirects', () => {
    const { browserWindow, contents, window } = nativeWindow()
    prepareNativeBrowserPopup(browserWindow, () => true)
    expect(window.setTitle).toHaveBeenLastCalledWith('about:blank')
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
    contents.mainFrame.url = 'https://destination.example.net/other'
    contents.emit('did-navigate', {}, 'https://destination.example.net/other')
    expect(window.setTitle).toHaveBeenLastCalledWith('https://destination.example.net')
  })
})
