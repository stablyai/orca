// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  let terminals: TerminalStub[]
  let writeCallbacks: Array<() => void>

  beforeEach(() => {
    animationFrames = []
    terminals = []
    writeCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
    Object.defineProperty(window, 'innerWidth', { value: 381, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 612, configurable: true })
    const webWindow = window as unknown as {
      Terminal: new () => TerminalStub
      ReactNativeWebView: { postMessage: (data: string) => void }
    }
    webWindow.Terminal = function () {
      const terminal = makeTerminal(writeCallbacks)
      terminals.push(terminal)
      return terminal
    } as unknown as new () => TerminalStub
    webWindow.ReactNativeWebView = { postMessage: vi.fn() }
    document.body.innerHTML = bodyMarkup()
    // eslint-disable-next-line no-new-func
    new Function(iifeSource())()
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
