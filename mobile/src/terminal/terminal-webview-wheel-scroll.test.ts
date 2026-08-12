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

type BufferState = {
  baseY: number
  type: 'alternate' | 'normal'
  viewportY: number
}

type TerminalStub = ReturnType<typeof makeTerminal>
type RegisteredWindowListener = {
  listener: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
  type: string
}

const CELL_HEIGHT = 15
const ESC = '\u001b'
const ESC_ARROW_DOWN = `${ESC}[B`
const ESC_APP_ARROW_UP = `${ESC}OA`

function makeTerminal(buffer: BufferState, scrollLines: (lines: number) => void) {
  const terminal = {
    cols: 40,
    rows: 24,
    options: { fontSize: 13 },
    modes: { mouseTrackingMode: 'none' as string },
    element: null as HTMLElement | null,
    _core: {
      _renderService: { dimensions: { css: { cell: { width: 8, height: CELL_HEIGHT } } } }
    },
    buffer: {
      active: {
        get baseY() {
          return buffer.baseY
        },
        get type() {
          return buffer.type
        },
        get viewportY() {
          return buffer.viewportY
        },
        cursorY: 0,
        length: 1,
        getLine: () => null
      }
    },
    write(_data: string, callback?: () => void) {
      callback?.()
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
    scrollLines,
    scrollToBottom() {},
    scrollToLine() {},
    attachCustomKeyEventHandler() {},
    getSelection: () => '',
    onData: () => ({ dispose() {} }),
    onLineFeed: () => ({ dispose() {} }),
    onScroll: () => ({ dispose() {} }),
    onWriteParsed: () => ({ dispose() {} }),
    dispose() {}
  }
  return terminal
}

function dispatchWheel(deltaY: number, init: WheelEventInit = {}): WheelEvent {
  const surface = document.getElementById('terminal-surface')
  if (!surface) {
    throw new Error('terminal surface missing')
  }
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 60,
    deltaMode: 0,
    deltaY,
    ...init
  })
  if (init.ctrlKey) {
    // Why: happy-dom drops modifier flags from the WheelEvent init dict.
    Object.defineProperty(event, 'ctrlKey', { value: true })
  }
  surface.dispatchEvent(event)
  return event
}

function terminalInputBytes(postMessage: ReturnType<typeof vi.fn>): string {
  return postMessage.mock.calls
    .map(([raw]) => JSON.parse(String(raw)) as { bytes?: string; type: string })
    .filter((msg) => msg.type === 'terminal-input')
    .map((msg) => msg.bytes ?? '')
    .join('')
}

describe('terminal WebView external pointer wheel scrolling', () => {
  let animationFrames: Array<() => void>
  let buffer: BufferState
  let postMessage: ReturnType<typeof vi.fn>
  let registeredWindowListeners: RegisteredWindowListener[]
  let scrollLines: ReturnType<typeof vi.fn>
  let terminals: TerminalStub[]

  function boot(): void {
    document.body.innerHTML = bodyMarkup()
    new Function(iifeSource())()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'init', cols: 40, rows: 24, initialData: '' })
      })
    )
    // Why: init commits the replacement surface on the next animation frame.
    while (animationFrames.length > 0) {
      animationFrames.shift()?.()
    }
  }

  function flushFrames(): void {
    for (let i = 0; i < 4 && animationFrames.length > 0; i++) {
      animationFrames.shift()?.()
    }
  }

  beforeEach(() => {
    animationFrames = []
    buffer = { baseY: 0, type: 'normal', viewportY: 0 }
    registeredWindowListeners = []
    scrollLines = vi.fn()
    terminals = []
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
    vi.stubGlobal('cancelAnimationFrame', () => {})
    Object.defineProperty(window, 'innerWidth', { value: 381, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 612, configurable: true })
    postMessage = vi.fn()
    const webWindow = window as unknown as {
      Terminal: new () => TerminalStub
      ReactNativeWebView: { postMessage: (data: string) => void }
    }
    webWindow.Terminal = function () {
      const terminal = makeTerminal(buffer, scrollLines)
      terminals.push(terminal)
      return terminal
    } as unknown as new () => TerminalStub
    webWindow.ReactNativeWebView = { postMessage }
  })

  afterEach(() => {
    for (const { type, listener, options } of registeredWindowListeners) {
      window.removeEventListener(type, listener as EventListener, options)
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('turns an alternate-screen wheel scroll into cursor keys (#6863, #8818)', () => {
    buffer = { baseY: 0, type: 'alternate', viewportY: 0 }
    boot()
    expect(terminals).toHaveLength(1)

    dispatchWheel(3 * CELL_HEIGHT)

    // Why: alt-screen TUIs (Claude Code, vim) have no scrollback, so an external
    // mouse/trackpad wheel must reach the PTY as cursor keys the way touch does.
    expect(terminalInputBytes(postMessage)).toBe(ESC_ARROW_DOWN.repeat(3))
  })

  it('sends application cursor keys when the TUI enabled DECCKM', () => {
    buffer = { baseY: 0, type: 'alternate', viewportY: 0 }
    boot()
    const terminal = terminals[0]
    if (!terminal) {
      throw new Error('terminal missing')
    }
    ;(terminal.modes as Record<string, unknown>).applicationCursorKeysMode = true

    dispatchWheel(-2 * CELL_HEIGHT)

    expect(terminalInputBytes(postMessage)).toBe(ESC_APP_ARROW_UP.repeat(2))
  })

  it('reports the wheel as mouse tracking bytes when the TUI asked for them', () => {
    buffer = { baseY: 0, type: 'alternate', viewportY: 0 }
    boot()
    const terminal = terminals[0]
    if (!terminal) {
      throw new Error('terminal missing')
    }
    terminal.modes.mouseTrackingMode = 'any'

    dispatchWheel(CELL_HEIGHT)

    // Default (non-SGR) encoding: wheel-down button 65 + 32 = 97 ('a'), then two
    // printable cell bytes (their value depends on the fit scale, not on routing).
    const bytes = terminalInputBytes(postMessage)
    expect(bytes.slice(0, 4)).toBe(`${ESC}[Ma`)
    expect(bytes).toHaveLength(6)
    expect(bytes.charCodeAt(4)).toBeGreaterThanOrEqual(33)
    expect(bytes.charCodeAt(5)).toBeGreaterThanOrEqual(33)
  })

  it('scrolls normal-buffer scrollback from a wheel instead of leaving it frozen', () => {
    buffer = { baseY: 20, type: 'normal', viewportY: 20 }
    boot()

    dispatchWheel(-3 * CELL_HEIGHT)
    flushFrames()

    expect(scrollLines).toHaveBeenCalledWith(-3)
  })

  it('converts line-mode deltas that Android reports for external mouse wheels', () => {
    buffer = { baseY: 0, type: 'alternate', viewportY: 0 }
    boot()

    dispatchWheel(2, { deltaMode: 1 })

    expect(terminalInputBytes(postMessage)).toBe(ESC_ARROW_DOWN.repeat(2))
  })

  it('swallows a trackpad pinch instead of firing cursor keys at the TUI', () => {
    buffer = { baseY: 0, type: 'alternate', viewportY: 0 }
    boot()

    const event = dispatchWheel(3 * CELL_HEIGHT, { ctrlKey: true })

    expect(terminalInputBytes(postMessage)).toBe('')
    expect(event.defaultPrevented).toBe(true)
  })

  it('claims the wheel so xterm does not double-apply it', () => {
    buffer = { baseY: 20, type: 'normal', viewportY: 20 }
    boot()

    const event = dispatchWheel(-CELL_HEIGHT)

    expect(event.defaultPrevented).toBe(true)
  })

  it('clears fractional wheel state when the terminal is recreated', () => {
    buffer = { baseY: 0, type: 'alternate', viewportY: 0 }
    boot()
    dispatchWheel(CELL_HEIGHT - 1)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'init', cols: 40, rows: 24, initialData: '' })
      })
    )
    flushFrames()
    dispatchWheel(1)

    expect(terminalInputBytes(postMessage)).toBe('')
  })
})
