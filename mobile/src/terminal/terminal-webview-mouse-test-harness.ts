import { runInThisContext } from 'node:vm'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
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
type RegisteredEventListener = {
  listener: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
  type: string
}

type PointerEventType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel'
type PointerEventInit = {
  button?: number
  buttons?: number
  pointerType?: string
  x?: number
  y?: number
}
type PostMessage = Mock<(data: string) => void>
type Select = Mock<(col: number, row: number, len: number) => void>

export const ESC = '\u001b'
export const DEFAULT_MOUSE_REPORT_RE = new RegExp(`${ESC}\\[M[\\s\\S]{3}`, 'g')

function makeTerminal(buffer: BufferState, select: Select) {
  const terminal = {
    cols: 40,
    rows: 24,
    options: { fontSize: 13 },
    modes: { mouseTrackingMode: 'none' as string },
    element: null as HTMLElement | null,
    _core: {
      _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } }
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
    select,
    scrollLines() {},
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

function terminalSurface(): HTMLElement {
  const surface = document.getElementById('terminal-surface')
  if (!surface) {
    throw new Error('terminal surface missing')
  }
  return surface
}

function dispatchPointer(type: PointerEventType, init: PointerEventInit = {}): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x ?? 40,
    clientY: init.y ?? 60,
    button: init.button ?? 0,
    buttons: init.buttons ?? 0
  })
  // Why: happy-dom's PointerEvent init drops pointerType; grafting it onto a
  // MouseEvent exercises the same duck-typed reads the WebView handler does.
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' })
  terminalSurface().dispatchEvent(event)
}

function mouseClick(x: number, y: number): void {
  dispatchPointer('pointerdown', { x, y, button: 0, buttons: 1 })
  dispatchPointer('pointerup', { x, y, button: 0, buttons: 0 })
}

function mouseDrag(x1: number, y1: number, x2: number, y2: number): void {
  dispatchPointer('pointerdown', { x: x1, y: y1, button: 0, buttons: 1 })
  const midX = Math.round((x1 + x2) / 2)
  const midY = Math.round((y1 + y2) / 2)
  dispatchPointer('pointermove', { x: midX, y: midY, button: 0, buttons: 1 })
  dispatchPointer('pointermove', { x: x2, y: y2, button: 0, buttons: 1 })
  dispatchPointer('pointerup', { x: x2, y: y2, button: 0, buttons: 0 })
}

function postedMessages(postMessage: PostMessage): Record<string, unknown>[] {
  return postMessage.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>)
}

function terminalInputBytes(postMessage: PostMessage): string {
  return postedMessages(postMessage)
    .filter((message) => message.type === 'terminal-input')
    .map((message) => (message.bytes as string) ?? '')
    .join('')
}

export function useTerminalMouseWebViewHarness() {
  let animationFrames: (() => void)[]
  let buffer: BufferState
  let postMessage: PostMessage
  let registeredDocumentListeners: RegisteredEventListener[]
  let registeredWindowListeners: RegisteredEventListener[]
  let select: Select
  let terminals: TerminalStub[]

  function boot(): void {
    document.body.innerHTML = bodyMarkup()
    runInThisContext(iifeSource())
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

  function activeTerminal(): TerminalStub {
    const terminal = terminals.at(-1)
    if (!terminal) {
      throw new Error('terminal missing')
    }
    return terminal
  }

  beforeEach(() => {
    animationFrames = []
    buffer = { baseY: 0, type: 'normal', viewportY: 0 }
    registeredDocumentListeners = []
    registeredWindowListeners = []
    select = vi.fn<(col: number, row: number, len: number) => void>()
    terminals = []
    const addDocumentEventListener = document.addEventListener.bind(document)
    vi.spyOn(document, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      registeredDocumentListeners.push({ type, listener, options })
      addDocumentEventListener(type, listener, options)
    }) as typeof document.addEventListener)
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
    postMessage = vi.fn<(data: string) => void>()
    const webWindow = window as unknown as {
      Terminal: new () => TerminalStub
      ReactNativeWebView: { postMessage: (data: string) => void }
    }
    webWindow.Terminal = function () {
      const terminal = makeTerminal(buffer, select)
      terminals.push(terminal)
      return terminal
    } as unknown as new () => TerminalStub
    webWindow.ReactNativeWebView = { postMessage }
  })

  afterEach(() => {
    for (const { type, listener, options } of registeredDocumentListeners) {
      document.removeEventListener(type, listener as EventListener, options)
    }
    for (const { type, listener, options } of registeredWindowListeners) {
      window.removeEventListener(type, listener as EventListener, options)
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  return {
    activeTerminal,
    boot,
    clearPostedMessages: () => postMessage.mockClear(),
    dispatchPointer,
    mouseClick,
    mouseDrag,
    postedMessages: () => postedMessages(postMessage),
    selectionSpy: () => select,
    terminalInputBytes: () => terminalInputBytes(postMessage),
    terminalSurface
  }
}
