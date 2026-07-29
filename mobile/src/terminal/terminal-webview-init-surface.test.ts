// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XTERM_HTML } from './terminal-webview-html'

function iifeSource(): string {
  const start = XTERM_HTML.indexOf('(function() {')
  const end = XTERM_HTML.lastIndexOf('})();')
  return XTERM_HTML.slice(start, end + '})();'.length)
}

function bodyMarkup(): string {
  const start = XTERM_HTML.indexOf('<body>') + '<body>'.length
  const end = XTERM_HTML.indexOf('<script>', start)
  return XTERM_HTML.slice(start, end)
}

type TerminalStub = ReturnType<typeof makeTerminal>
type TerminalOptions = {
  cursorInactiveStyle?: string
  cursorStyle?: string
}
type RegisteredWindowListener = {
  listener: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
  type: string
}

function makeTerminal(writeCallbacks: Array<() => void>) {
  const terminal = {
    cols: 80,
    rows: 24,
    options: { fontSize: 13 },
    modes: {},
    element: null as HTMLElement | null,
    disposed: false,
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } },
    buffer: {
      active: {
        viewportY: 0,
        baseY: 0,
        length: 1,
        cursorY: 0,
        type: 'normal' as const,
        getLine: () => null
      }
    },
    write(_data: string, callback?: () => void) {
      if (callback) {
        writeCallbacks.push(callback)
      }
    },
    open(surface: HTMLElement) {
      terminal.element = surface
    },
    loadAddon() {},
    resize(cols: number, rows: number) {
      terminal.cols = cols
      terminal.rows = rows
    },
    clear() {},
    reset() {},
    refresh() {},
    selectAll() {},
    clearSelection() {},
    select() {},
    scrollLines() {},
    scrollToBottom() {},
    scrollToLine() {},
    getSelection: () => '',
    onData: () => ({ dispose() {} }),
    onLineFeed: () => ({ dispose() {} }),
    onScroll: () => ({ dispose() {} }),
    onWriteParsed: () => ({ dispose() {} }),
    dispose() {
      terminal.disposed = true
    }
  }
  return terminal
}

function dispatchInit(cols: number, initialData: string): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'init', cols, rows: 40, initialData })
    })
  )
}

describe('terminal WebView init surface replacement', () => {
  let animationFrames: Array<() => void>
  let registeredWindowListeners: RegisteredWindowListener[]
  let terminalOptions: TerminalOptions[]
  let terminals: TerminalStub[]
  let writeCallbacks: Array<() => void>

  beforeEach(() => {
    animationFrames = []
    registeredWindowListeners = []
    terminalOptions = []
    terminals = []
    writeCallbacks = []
    const addWindowEventListener = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      registeredWindowListeners.push({ type, listener, options })
      addWindowEventListener(type, listener, options)
    }) as typeof window.addEventListener)
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
    Object.defineProperty(window, 'innerWidth', { value: 381, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 612, configurable: true })
    const webWindow = window as unknown as {
      Terminal: new (options: TerminalOptions) => TerminalStub
      ReactNativeWebView: { postMessage: (data: string) => void }
    }
    webWindow.Terminal = function (options: TerminalOptions) {
      terminalOptions.push(options)
      const terminal = makeTerminal(writeCallbacks)
      terminals.push(terminal)
      return terminal
    } as unknown as new (options: TerminalOptions) => TerminalStub
    webWindow.ReactNativeWebView = { postMessage: vi.fn() }
    document.body.innerHTML = bodyMarkup()
    // eslint-disable-next-line no-new-func
    new Function(iifeSource())()
  })

  afterEach(() => {
    for (const { type, listener, options } of registeredWindowListeners) {
      window.removeEventListener(type, listener as EventListener, options)
    }
    vi.restoreAllMocks()
  })

  it("keeps xterm's inactive cursor visible across replacement surfaces", () => {
    dispatchInit(120, 'desktop')
    dispatchInit(51, 'phone-resize')
    dispatchInit(51, 'phone-scrollback')

    expect(terminalOptions).toHaveLength(3)
    for (const options of terminalOptions) {
      expect(options).toMatchObject({
        cursorStyle: 'bar',
        cursorInactiveStyle: 'bar'
      })
    }
  })

  it('commits only the newest surface when phone-fit init calls overlap', () => {
    // Why: restored terminals can receive desktop scrollback, a phone resize,
    // and phone scrollback before any xterm replay callback has completed.
    dispatchInit(120, 'desktop')
    animationFrames.shift()?.()
    dispatchInit(51, 'phone-resize')
    animationFrames.shift()?.()
    dispatchInit(51, 'phone-scrollback')
    animationFrames.shift()?.()

    expect(terminals).toHaveLength(3)
    expect(writeCallbacks).toHaveLength(3)
    writeCallbacks[2]?.()
    writeCallbacks[0]?.()
    writeCallbacks[1]?.()

    const surfaces = document.querySelectorAll('#terminal-container > div')
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.id).toBe('terminal-surface')
    expect((surfaces[0] as HTMLElement).style.visibility).toBe('visible')
    expect(terminals.map((terminal) => terminal.disposed)).toEqual([true, true, false])
  })
})
