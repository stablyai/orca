import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => void

type FakeWebContents = {
  mainFrame: { url: string; origin: string }
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
  emit: (event: string, ...args: unknown[]) => void
}

const { fakeElectron } = vi.hoisted(() => {
  function createFakeWebContents(): FakeWebContents {
    const handlers = new Map<string, Handler[]>()
    let destroyed = false
    const add = (event: string, handler: Handler): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    }
    const mainFrame = { url: '', origin: '' }
    return {
      mainFrame,
      on: vi.fn(add),
      once: vi.fn(add),
      off: vi.fn((event: string, handler: Handler) => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== handler)
        )
      }),
      executeJavaScript: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve()),
      close: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      // Electron marks contents destroyed before emitting destroyed; the close guard depends on this.
      isDestroyed: vi.fn(() => destroyed),
      emit: (event: string, ...args: unknown[]) => {
        if (event === 'did-navigate' || (event === 'did-navigate-in-page' && args[2])) {
          mainFrame.url = String(args[1])
        }
        if (event === 'destroyed') {
          destroyed = true
        }
        for (const handler of handlers.get(event) ?? []) {
          handler(...args)
        }
      }
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    options: { webContents?: FakeWebContents; webPreferences?: unknown }
    webContents: FakeWebContents
    setBounds = vi.fn()
    constructor(options: { webContents?: FakeWebContents; webPreferences?: unknown }) {
      // Electron rejects explicitly undefined webContents.
      if (Object.hasOwn(options, 'webContents') && options.webContents === undefined) {
        throw new TypeError('options.webContents must be a WebContents')
      }
      this.options = options
      this.webContents = options.webContents ?? createFakeWebContents()
      FakeWebContentsView.instances.push(this)
    }
  }

  class FakeContentView {
    private handlers = new Map<string, Handler[]>()
    addChildView = vi.fn()
    on(event: string, handler: Handler): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    }
    emit(event: string): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler()
      }
    }
  }

  class FakeBaseWindow {
    static instances: FakeBaseWindow[] = []
    options: Record<string, unknown>
    private handlers = new Map<string, Handler[]>()
    contentView = new FakeContentView()
    contentSize: { width: number; height: number }
    setTitle = vi.fn()
    isDestroyed = vi.fn(() => false)
    close = vi.fn(() => this.emit('closed'))
    constructor(options: Record<string, unknown>) {
      this.options = options
      this.contentSize = { width: Number(options.width), height: Number(options.height) }
      FakeBaseWindow.instances.push(this)
    }
    on(event: string, handler: Handler): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    }
    once(event: string, handler: Handler): void {
      this.on(event, handler)
    }
    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, ...this.contentSize }
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args)
      }
    }
  }

  return {
    fakeElectron: { createFakeWebContents, FakeWebContentsView, FakeBaseWindow }
  }
})

vi.mock('electron', () => ({
  BaseWindow: fakeElectron.FakeBaseWindow,
  WebContentsView: fakeElectron.FakeWebContentsView
}))

import {
  describePopupOrigin,
  openPopupWithOriginBar,
  POPUP_ORIGIN_BAR_HEIGHT
} from './popup-origin-bar-window'
import { getNativePopupQuitSurface } from './native-browser-popup-windows'

const { createFakeWebContents, FakeWebContentsView, FakeBaseWindow } = fakeElectron

function fakePopupContents(): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake implements every WebContents member exercised by the popup factory.
  return createFakeWebContents() as unknown as Electron.WebContents
}

function lastWindow(): InstanceType<typeof FakeBaseWindow> {
  const instance = FakeBaseWindow.instances.at(-1)
  if (!instance) {
    throw new Error('no BaseWindow was constructed')
  }
  return instance
}

// View construction order in openPopupWithOriginBar: origin bar first, content second.
function lastViews(): {
  bar: InstanceType<typeof FakeWebContentsView>
  content: InstanceType<typeof FakeWebContentsView>
} {
  const bar = FakeWebContentsView.instances.at(-2)
  const content = FakeWebContentsView.instances.at(-1)
  if (!bar || !content) {
    throw new Error('expected an origin bar view and a content view')
  }
  return { bar, content }
}

beforeEach(() => {
  FakeBaseWindow.instances = []
  FakeWebContentsView.instances = []
})
afterEach(() => vi.unstubAllEnvs())

describe('describePopupOrigin', () => {
  it('reduces URLs to origin only', () => {
    expect(describePopupOrigin('https://accounts.example.com/oauth?code=SECRET')).toEqual({
      label: 'https://accounts.example.com',
      insecure: false
    })
  })

  it('flags plain http to remote hosts as insecure', () => {
    expect(describePopupOrigin('http://phish.example.net/login')).toEqual({
      label: 'http://phish.example.net',
      insecure: true
    })
  })

  it('treats loopback http as secure', () => {
    expect(describePopupOrigin('http://localhost:3000/callback').insecure).toBe(false)
    expect(describePopupOrigin('http://127.0.0.1:8080/').insecure).toBe(false)
    expect(describePopupOrigin('http://[::1]:8080/').insecure).toBe(false)
    expect(describePopupOrigin('http://app.localhost/callback').insecure).toBe(false)
  })

  it('labels about:blank popups', () => {
    expect(describePopupOrigin('about:blank')).toEqual({ label: 'about:blank', insecure: false })
  })

  it('falls back to unknown for unparseable URLs', () => {
    expect(describePopupOrigin('not a url')).toEqual({ label: 'unknown', insecure: true })
  })
})

describe('openPopupWithOriginBar', () => {
  it('owns BaseWindow page/bar input and keeps the hold notice in its trusted origin bar', () => {
    const popup = openPopupWithOriginBar({ webContents: fakePopupContents() }, 'about:blank')
    const { bar } = lastViews()
    const owner = getNativePopupQuitSurface(popup.contentWebContents)
    expect(owner?.window).toBe(lastWindow())
    expect(getNativePopupQuitSurface(bar.webContents)).toBe(owner)
    owner?.notice({ phase: 'starting' })
    expect(bar.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 800, height: 98 })
    expect(lastViews().content.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 34,
      width: 800,
      height: 600
    })
    bar.webContents.emit('did-finish-load')
    expect(bar.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('Agents are still working. Hold ⌘Q to quit.')
    )
    owner?.notice({ phase: 'holding' })
    expect(bar.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"phase":"holding"')
    )
    owner?.notice({ phase: 'released' })
    expect(bar.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"phase":"released"')
    )
    expect(bar.webContents.loadURL.mock.calls[0][0]).toContain('id%3D%22origin%22')
    lastWindow().emit('closed')
    expect(getNativePopupQuitSurface(popup.contentWebContents)).toBeUndefined()
    const calls = bar.webContents.executeJavaScript.mock.calls.length
    owner?.notice({ phase: 'holding' })
    expect(bar.webContents.executeJavaScript).toHaveBeenCalledTimes(calls)
  })
  it('adopts the pre-created popup contents so window.opener and the session survive', () => {
    const adopted = createFakeWebContents()
    const webPreferences = { partition: 'persist:browser' }
    const popup = openPopupWithOriginBar(
      { webContents: adopted as never, webPreferences },
      'https://example.com/login'
    )

    const { content } = lastViews()
    expect(content.options.webContents).toBe(adopted)
    expect(content.options.webPreferences).toBe(webPreferences)
    expect(popup.contentWebContents).toBe(adopted)
    // Chromium already drives the adopted contents' navigation.
    expect(adopted.loadURL).not.toHaveBeenCalled()
  })

  it('fails closed without replaying a request when no adopted contents were supplied', () => {
    const popup = openPopupWithOriginBar({}, 'https://example.com/login')
    const onClosed = vi.fn()
    popup.onClosed(onClosed)
    expect(popup.contentWebContents.loadURL).not.toHaveBeenCalled()
    expect(lastWindow().close).toHaveBeenCalledTimes(1)
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('loads a page-less GET itself only when asked and only after preparation passes', () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
    const popup = openPopupWithOriginBar(
      { loadInitialUrl: true },
      'https://example.com/docs',
      (contents) => {
        expect(contents.loadURL).not.toHaveBeenCalled()
        return true
      }
    )
    expect(lastWindow().options.show).toBe(true)
    expect(popup.contentWebContents.loadURL).toHaveBeenCalledWith('https://example.com/docs')

    const refused = openPopupWithOriginBar(
      { loadInitialUrl: true },
      'https://example.com/denied',
      () => false
    )
    expect(refused.contentWebContents.loadURL).not.toHaveBeenCalled()
    expect(lastWindow().close).toHaveBeenCalledTimes(1)
  })

  it('honors explicit hidden windows and background launches', () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
    openPopupWithOriginBar({ show: false, webContents: fakePopupContents() }, 'about:blank')
    expect(lastWindow().options.show).toBe(false)
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    openPopupWithOriginBar({ show: true, webContents: fakePopupContents() }, 'about:blank')
    expect(lastWindow().options.show).toBe(false)
  })

  it('reserves an origin-bar strip above the requested content size', () => {
    openPopupWithOriginBar(
      { webContents: createFakeWebContents() as never, width: 500, height: 400 },
      'https://example.com/'
    )

    expect(lastWindow().options).toMatchObject({
      width: 500,
      height: 400 + POPUP_ORIGIN_BAR_HEIGHT,
      autoHideMenuBar: true
    })
    const { bar, content } = lastViews()
    expect(bar.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 500,
      height: POPUP_ORIGIN_BAR_HEIGHT
    })
    expect(content.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: POPUP_ORIGIN_BAR_HEIGHT,
      width: 500,
      height: 400
    })
  })

  it('re-lays out when the revealed menu bar shrinks the content area', () => {
    openPopupWithOriginBar(
      { webContents: createFakeWebContents() as never, width: 500, height: 400 },
      'https://example.com/'
    )
    const window = lastWindow()
    const menuBarHeight = 25
    window.contentSize = { width: 500, height: 400 + POPUP_ORIGIN_BAR_HEIGHT - menuBarHeight }
    window.contentView.emit('bounds-changed')

    expect(lastViews().content.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: POPUP_ORIGIN_BAR_HEIGHT,
      width: 500,
      height: 400 - menuBarHeight
    })
  })

  it('keeps the origin bar isolated with locked-down webPreferences', () => {
    openPopupWithOriginBar(
      { webContents: createFakeWebContents() as never },
      'https://example.com/'
    )
    const { bar } = lastViews()
    expect(bar.options.webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('renders only the committed origin in the bar, never path or query', () => {
    const adopted = createFakeWebContents()
    adopted.mainFrame.url = 'https://accounts.example.com/oauth?code=SECRET'
    openPopupWithOriginBar(
      { webContents: adopted as never },
      'https://accounts.example.com/oauth?code=SECRET'
    )
    const { bar } = lastViews()
    bar.webContents.emit('did-finish-load')

    expect(bar.webContents.executeJavaScript).toHaveBeenCalledTimes(2)
    const script = bar.webContents.executeJavaScript.mock.calls[0][0] as string
    expect(script).toContain('"https://accounts.example.com"')
    expect(script).not.toContain('SECRET')
    expect(script).not.toContain('/oauth')
    expect(lastWindow().options.title).toBe('about:blank')
  })

  it('updates the origin bar and title when the popup navigates', () => {
    const adopted = createFakeWebContents()
    openPopupWithOriginBar({ webContents: adopted as never }, 'about:blank')
    const { bar } = lastViews()
    bar.webContents.emit('did-finish-load')
    bar.webContents.executeJavaScript.mockClear()

    adopted.emit('did-navigate', {}, 'http://phish.example.net/login?token=SECRET')

    const script = bar.webContents.executeJavaScript.mock.calls[0][0] as string
    expect(script).toContain("classList.toggle('insecure', true)")
    expect(script).toContain('"http://phish.example.net"')
    expect(script).not.toContain('SECRET')
    expect(lastWindow().setTitle).toHaveBeenCalledWith('http://phish.example.net')
  })

  it('shows the page title in the native title bar but resets to origin on navigation', () => {
    const adopted = createFakeWebContents()
    openPopupWithOriginBar(
      { webContents: adopted as never },
      'https://accounts.example.com/oauth?code=SECRET'
    )
    expect(lastWindow().options.title).toBe('about:blank')
    const blankTitleEvent = { preventDefault: vi.fn() }
    adopted.emit('page-title-updated', blankTitleEvent, 'Uncommitted destination')
    expect(blankTitleEvent.preventDefault).toHaveBeenCalledOnce()
    expect(lastWindow().setTitle).toHaveBeenLastCalledWith('about:blank')
    adopted.emit('did-navigate', {}, 'https://accounts.example.com/oauth')

    const committedTitleEvent = { preventDefault: vi.fn() }
    adopted.emit('page-title-updated', committedTitleEvent, 'Sign in to Example')
    expect(committedTitleEvent.preventDefault).toHaveBeenCalledOnce()
    expect(lastWindow().setTitle).toHaveBeenLastCalledWith('Sign in to Example')

    adopted.emit('did-navigate', {}, 'https://evil.example.net/')
    expect(lastWindow().setTitle).toHaveBeenLastCalledWith('https://evil.example.net')
  })

  it.each(['about:blank', 'about:blank#state', 'about:blank?state=1'])(
    'keeps opener-written %s content neutral across failed navigation and delayed bar loading',
    (url) => {
      const adopted = createFakeWebContents()
      adopted.mainFrame.url = url
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the presenter's WebContents surface.
      openPopupWithOriginBar({ webContents: adopted as never }, 'https://requested.example/auth')
      const { bar } = lastViews()
      lastWindow().setTitle.mockClear()
      adopted.emit('page-title-updated', { preventDefault: vi.fn() }, 'https://requested.example')
      expect(lastWindow().setTitle).not.toHaveBeenCalled()
      adopted.emit('did-start-navigation', {}, 'https://requested.example/auth')
      adopted.emit('will-redirect', {}, 'https://redirect.example/auth')
      adopted.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://redirect.example/auth', true)
      adopted.emit('did-finish-load')
      bar.webContents.emit('did-finish-load')
      expect(lastWindow().setTitle).toHaveBeenLastCalledWith('about:blank')
      expect(bar.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('"about:blank"')
      expect(bar.webContents.executeJavaScript.mock.calls.flat().join('')).not.toContain(
        'requested.example'
      )
    }
  )

  it('checks the committed document when a title arrives before its navigation event', () => {
    const adopted = createFakeWebContents()
    adopted.mainFrame.url = 'https://committed.example/'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the presenter's WebContents surface.
    openPopupWithOriginBar({ webContents: adopted as never }, 'https://requested.example/')
    lastWindow().setTitle.mockClear()
    adopted.mainFrame.url = 'about:blank#state'
    adopted.emit(
      'page-title-updated',
      { preventDefault: vi.fn() },
      'https://accounts.trusted.example'
    )
    expect(lastWindow().setTitle).not.toHaveBeenCalled()
    lastViews().bar.webContents.emit('did-finish-load')
    expect(lastWindow().setTitle).toHaveBeenLastCalledWith('about:blank')
  })

  it('retains the committed origin through pending redirects and renders the latest commit when the bar loads', () => {
    const adopted = createFakeWebContents()
    adopted.mainFrame.url = 'https://committed.example/private'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the presenter's WebContents surface.
    openPopupWithOriginBar({ webContents: adopted as never }, 'https://requested.example/')
    const { bar } = lastViews()
    adopted.emit('will-redirect', {}, 'https://pending.example/')
    adopted.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://pending.example/', true)
    adopted.emit('did-finish-load')
    expect(bar.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain(
      '"https://committed.example"'
    )
    adopted.emit('did-navigate', {}, 'http://next.example/path?secret=synthetic')
    bar.webContents.emit('did-finish-load')
    expect(bar.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain(
      '"http://next.example"'
    )
    adopted.mainFrame.url = 'chrome-error://chromewebdata/'
    adopted.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://failed.example/',
      true
    )
    expect(bar.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('"chrome-error:"')
  })

  it.each([1, 1000])('preserves the page title through %i subframe failures', (count) => {
    const adopted = createFakeWebContents()
    adopted.mainFrame.url = 'https://committed.example/'
    adopted.mainFrame.origin = 'https://committed.example'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the presenter's WebContents surface.
    openPopupWithOriginBar({ webContents: adopted as never }, adopted.mainFrame.url)
    const { bar } = lastViews()
    bar.webContents.emit('did-finish-load')
    adopted.emit('page-title-updated', { preventDefault: vi.fn() }, 'Stable popup title')
    bar.webContents.executeJavaScript.mockClear()
    const titleUpdates = lastWindow().setTitle.mock.calls.length

    for (let index = 0; index < count; index += 1) {
      adopted.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://iframe.example/', false)
    }
    expect(lastWindow().setTitle).toHaveBeenCalledTimes(titleUpdates)
    expect(lastWindow().setTitle).toHaveBeenLastCalledWith('Stable popup title')
    expect(bar.webContents.executeJavaScript).not.toHaveBeenCalled()

    adopted.mainFrame.url = 'https://failed.example/'
    adopted.mainFrame.origin = 'null'
    adopted.emit('did-fail-load', {}, -2, 'ERR_FAILED', adopted.mainFrame.url, true)
    expect(lastWindow().setTitle).toHaveBeenCalledTimes(titleUpdates + 1)
    expect(lastWindow().setTitle).toHaveBeenLastCalledWith('unknown')
    expect(bar.webContents.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(bar.webContents.executeJavaScript.mock.calls[0][0]).toContain('"unknown"')
  })

  it('never labels an opaque committed error or sandboxed document with its network URL', () => {
    const adopted = createFakeWebContents()
    adopted.mainFrame.url = 'https://opaque.example/document'
    adopted.mainFrame.origin = 'null'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the presenter's WebContents surface.
    openPopupWithOriginBar({ webContents: adopted as never }, 'https://requested.example/')
    const { bar } = lastViews()
    bar.webContents.emit('did-finish-load')
    expect(bar.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('"unknown"')
    adopted.mainFrame.origin = 'https://committed.example'
    adopted.emit('did-navigate', {}, 'https://committed.example/')
    adopted.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://failed.example/', true)
    expect(bar.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain(
      '"https://committed.example"'
    )
    adopted.mainFrame.url = 'https://failed.example/'
    adopted.mainFrame.origin = 'null'
    adopted.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://failed.example/', true)
    expect(bar.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('"unknown"')
    expect(bar.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain(
      "classList.toggle('insecure', true)"
    )
  })

  it('closes the window when the popup content is destroyed, without re-closing the contents', () => {
    const adopted = createFakeWebContents()
    openPopupWithOriginBar({ webContents: adopted as never }, 'https://example.com/')
    const { bar } = lastViews()

    adopted.emit('destroyed')

    expect(lastWindow().close).toHaveBeenCalled()
    expect(adopted.close).not.toHaveBeenCalled()
    expect(bar.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('re-asserts the origin when the popup finishes loading', () => {
    const adopted = createFakeWebContents()
    openPopupWithOriginBar({ webContents: adopted as never }, 'https://example.com/login')
    const { bar } = lastViews()
    bar.webContents.emit('did-finish-load')
    bar.webContents.executeJavaScript.mockClear()

    adopted.emit('did-navigate', {}, 'https://example.com/login')
    bar.webContents.executeJavaScript.mockClear()
    adopted.emit('did-finish-load')

    expect(bar.webContents.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(bar.webContents.executeJavaScript.mock.calls[0][0]).toContain('"https://example.com"')
  })

  it('elides the start of long origins so the registrable domain stays visible', () => {
    openPopupWithOriginBar(
      { webContents: createFakeWebContents() as never },
      'https://example.com/'
    )
    const { bar } = lastViews()
    const dataUrl = bar.webContents.loadURL.mock.calls[0][0] as string
    const html = decodeURIComponent(dataUrl.replace('data:text/html;charset=utf-8,', ''))
    expect(html).toContain('<bdi id="origin">')
    expect(html).toMatch(/#origin-clip\s*{[^}]*direction:\s*rtl/)
    expect(html).toMatch(/#origin\s*{[^}]*direction:\s*ltr/)
  })

  it('closes the popup content and notifies listeners when the window closes', () => {
    const adopted = createFakeWebContents()
    const onClosed = vi.fn()
    const popup = openPopupWithOriginBar({ webContents: adopted as never }, 'https://example.com/')
    const { bar } = lastViews()
    popup.onClosed(onClosed)

    popup.close()

    expect(adopted.close).toHaveBeenCalledTimes(1)
    expect(bar.webContents.close).toHaveBeenCalledTimes(1)
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('releases every origin bar across repeated popup lifecycles', () => {
    const cycleCount = 25
    const originBars: FakeWebContents[] = []

    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      const popup = openPopupWithOriginBar(
        { webContents: fakePopupContents() },
        `https://example.com/${cycle}`
      )
      originBars.push(lastViews().bar.webContents)
      popup.close()
    }

    expect(originBars.filter((contents) => contents.close.mock.calls.length === 1)).toHaveLength(
      cycleCount
    )
  })

  it('tolerates an origin bar destroyed before its window closes', () => {
    const adopted = createFakeWebContents()
    const onClosed = vi.fn()
    const popup = openPopupWithOriginBar({ webContents: adopted as never }, 'https://example.com/')
    popup.onClosed(onClosed)
    const { bar } = lastViews()
    const barWebContents = bar.webContents
    barWebContents.emit('destroyed')
    Object.defineProperty(bar, 'webContents', { get: () => undefined })

    expect(() => popup.close()).not.toThrow()
    expect(adopted.close).toHaveBeenCalledTimes(1)
    expect(barWebContents.close).not.toHaveBeenCalled()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('closes both child contents when popup preparation fails', () => {
    const adopted = createFakeWebContents()

    openPopupWithOriginBar({ webContents: adopted as never }, 'https://example.com/', () => false)

    // A plain target=_blank link's first request is already pending; only a navigation veto stops it.
    const navigation = { preventDefault: vi.fn() }
    adopted.emit('will-navigate', navigation, 'https://example.com/')
    expect(navigation.preventDefault).toHaveBeenCalledOnce()
    expect(adopted.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
    expect(adopted.close).toHaveBeenCalledTimes(1)
    expect(lastViews().bar.webContents.close).toHaveBeenCalledTimes(1)
    expect(lastWindow().close).toHaveBeenCalledTimes(1)
  })
})
