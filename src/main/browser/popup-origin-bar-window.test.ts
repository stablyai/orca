import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => void

type FakeWebContents = {
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
}

const { fakeElectron } = vi.hoisted(() => {
  function createFakeWebContents(): FakeWebContents {
    const handlers = new Map<string, Handler[]>()
    let destroyed = false
    const add = (event: string, handler: Handler): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    }
    return {
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
      // Mirrors real Electron: isDestroyed() is already true inside a
      // 'destroyed' handler, which is what the double-close guard relies on.
      isDestroyed: vi.fn(() => destroyed),
      emit: (event: string, ...args: unknown[]) => {
        if (event === 'destroyed') {
          destroyed = true
        }
        // off() replaces the stored array, so iterating the fetched one is safe.
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
      // Why: Electron rejects explicit undefined instead of treating it as
      // omitted, which the popup fallback path depends on.
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

  it('renders only the origin in the bar, never path or query', () => {
    openPopupWithOriginBar(
      { webContents: createFakeWebContents() as never },
      'https://accounts.example.com/oauth?code=SECRET'
    )
    const { bar } = lastViews()
    bar.webContents.emit('did-finish-load')

    expect(bar.webContents.executeJavaScript).toHaveBeenCalledTimes(1)
    const script = bar.webContents.executeJavaScript.mock.calls[0][0] as string
    expect(script).toContain('"https://accounts.example.com"')
    expect(script).not.toContain('SECRET')
    expect(script).not.toContain('/oauth')
    expect(lastWindow().options.title).toBe('https://accounts.example.com')
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
    // Until the page supplies a title, the window title is the origin.
    expect(lastWindow().options.title).toBe('https://accounts.example.com')

    adopted.emit('page-title-updated', {}, 'Sign in to Example')
    expect(lastWindow().setTitle).toHaveBeenLastCalledWith('Sign in to Example')

    // A stale title must not survive a cross-origin navigation.
    adopted.emit('did-navigate', {}, 'https://evil.example.net/')
    expect(lastWindow().setTitle).toHaveBeenLastCalledWith('https://evil.example.net')
  })

  it('closes the window when the popup content is destroyed, without re-closing the contents', () => {
    const adopted = createFakeWebContents()
    openPopupWithOriginBar({ webContents: adopted as never }, 'https://example.com/')
    const { bar } = lastViews()

    adopted.emit('destroyed')

    expect(lastWindow().close).toHaveBeenCalled()
    // The window's closed handler must not call close() on already-destroyed
    // contents — that throws in real Electron.
    expect(adopted.close).not.toHaveBeenCalled()
    expect(bar.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('re-asserts the origin when the popup finishes loading', () => {
    const adopted = createFakeWebContents()
    openPopupWithOriginBar({ webContents: adopted as never }, 'https://example.com/login')
    const { bar } = lastViews()
    bar.webContents.emit('did-finish-load')
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
    // rtl clip container ellipsizes the left; the isolated ltr bdi keeps the
    // origin's own characters (host, port) in normal order.
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
