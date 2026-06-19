// @vitest-environment jsdom
// Exercises the in-WebView touch dispatcher end-to-end: a surface tap on a
// printed http(s) URL must post an `open-url` message (which RN routes to the
// in-app/phone browser). Regression guard for taps that jitter a few pixels —
// those were being swallowed because the tap shared the long-press slop gate.
import { beforeEach, describe, expect, it } from 'vitest'
import { XTERM_HTML } from './terminal-webview-html'

function iifeSource(): string {
  const start = XTERM_HTML.indexOf('(function() {')
  const end = XTERM_HTML.lastIndexOf('})();')
  return XTERM_HTML.slice(start, end + '})();'.length)
}

function bodyMarkup(): string {
  const start = XTERM_HTML.indexOf('<body>') + '<body>'.length
  const end = XTERM_HTML.indexOf('<script src=')
  return XTERM_HTML.slice(start, end)
}

// Minimal xterm stub: one scrollback line containing a URL, fixed 8x15 cells.
function makeTerminal(lineRef: { current: string }) {
  return {
    cols: 80,
    rows: 24,
    options: { fontSize: 13 },
    modes: {},
    element: { scrollWidth: 800, scrollHeight: 360 },
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } },
    buffer: {
      active: {
        viewportY: 0,
        baseY: 0,
        length: 1,
        cursorY: 0,
        type: 'normal' as const,
        getLine(row: number) {
          const text = row === 0 ? lineRef.current : undefined
          if (text === undefined) {
            return null
          }
          return {
            // Honor (trimRight, startCol, endCol) like real xterm so the
            // cell→string-index conversion (cellColToStringIndex) resolves correctly.
            translateToString: (_trim?: boolean, start?: number, end?: number) =>
              text.slice(start ?? 0, end ?? text.length),
            getCell: () => ({ extended: undefined })
          }
        }
      }
    },
    write(_d: string, cb?: () => void) {
      cb?.()
    },
    open() {},
    resize() {},
    clear() {},
    reset() {},
    refresh() {},
    selectAll() {},
    clearSelection() {},
    select() {},
    scrollLines() {},
    scrollToBottom() {},
    getSelection: () => '',
    onLineFeed: () => ({ dispose() {} }),
    onScroll: () => ({ dispose() {} }),
    onWriteParsed: () => ({ dispose() {} }),
    dispose() {}
  }
}

type Posted = Array<Record<string, unknown>>

type OscLinkRange = { row: number; startCol: number; endCol: number; uri: string }

function boot(
  line: string,
  oscLinks?: OscLinkRange[]
): { posted: Posted; setLine: (line: string) => void } {
  const posted: Posted = []
  const lineRef = { current: line }
  const w = window as unknown as { Terminal: unknown; ReactNativeWebView: unknown }
  w.Terminal = function () {
    return makeTerminal(lineRef)
  }
  w.ReactNativeWebView = {
    postMessage(s: string) {
      posted.push(JSON.parse(s))
    }
  }
  document.body.innerHTML = bodyMarkup()
  // eslint-disable-next-line no-new-func
  new Function(iifeSource())()
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'init', cols: 80, rows: 24, initialData: '', oscLinks })
    })
  )
  return {
    posted,
    setLine: (nextLine: string) => {
      lineRef.current = nextLine
    }
  }
}

function fireTouch(type: string, touches: Array<{ x: number; y: number }>): void {
  const surface = document.getElementById('terminal-surface') as HTMLElement
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'touches', {
    value: touches.map((p, i) => ({ identifier: i, clientX: p.x, clientY: p.y, target: surface }))
  })
  Object.defineProperty(ev, 'target', { value: surface })
  document.dispatchEvent(ev)
}

// Wait one macrotask so init()'s rAF chain (term.open -> ready) settles.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

describe('terminal WebView tap routing', () => {
  // Fit scale here is min(1, innerWidth / (cellW*cols)) = 200 / 640 = 0.3125.
  // A URL at column 12 sits at screen x = 12 * 8 * 0.3125 = 30px, y within row 0.
  const URL_LINE = 'visit https://example.com/foo now'
  const tapX = 12 * 8 * 0.3125
  const tapY = 2
  const screenXForCol = (col: number): number => col * 8 * 0.3125

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true })
  })

  it('posts open-url when a clean tap lands on a URL', async () => {
    const { posted } = boot(URL_LINE)
    await settle()
    fireTouch('touchstart', [{ x: tapX, y: tapY }])
    fireTouch('touchend', [])
    expect(posted.find((m) => m.type === 'open-url')?.url).toBe('https://example.com/foo')
  })

  it('still posts open-url when the tap jitters a few pixels', async () => {
    // Why: a finger rarely lands perfectly still. Movement under TAP_SLOP must
    // not reclassify the tap as a scroll and drop the link open.
    const { posted } = boot(URL_LINE)
    await settle()
    fireTouch('touchstart', [{ x: tapX, y: tapY }])
    fireTouch('touchmove', [{ x: tapX + 11, y: tapY + 4 }])
    fireTouch('touchend', [])
    expect(posted.find((m) => m.type === 'open-url')?.url).toBe('https://example.com/foo')
  })

  it('opens the URL even right after a width-change reflow', async () => {
    // Why: scrollback reflow rewraps the local buffer; the tap path must keep
    // working afterward (the reflow message must not disturb tap routing).
    const { posted } = boot(URL_LINE)
    await settle()
    window.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ type: 'reflow', cols: 100, rows: 24 }) })
    )
    fireTouch('touchstart', [{ x: tapX, y: tapY }])
    fireTouch('touchend', [])
    expect(posted.find((m) => m.type === 'open-url')?.url).toBe('https://example.com/foo')
  })

  it('opens first-load OSC links from snapshot metadata on the exact cell range', async () => {
    const oscLinks = [{ row: 0, startCol: 6, endCol: 11, uri: 'https://example.com/issue/1234' }]
    const { posted } = boot('issue #1234 done', oscLinks)
    await settle()

    fireTouch('touchstart', [{ x: screenXForCol(7), y: tapY }])
    fireTouch('touchend', [])

    expect(posted.find((m) => m.type === 'open-url')?.url).toBe('https://example.com/issue/1234')
  })

  it('does not open snapshot OSC links from adjacent terminal cells', async () => {
    const oscLinks = [{ row: 0, startCol: 6, endCol: 11, uri: 'https://example.com/issue/1234' }]
    const { posted } = boot('issue #1234 done', oscLinks)
    await settle()

    fireTouch('touchstart', [{ x: screenXForCol(12), y: tapY }])
    fireTouch('touchend', [])

    expect(posted.find((m) => m.type === 'open-url')).toBeUndefined()
  })

  it('does not open stale snapshot OSC links after the row text changes', async () => {
    const oscLinks = [{ row: 0, startCol: 6, endCol: 11, uri: 'https://example.com/issue/1234' }]
    const { posted, setLine } = boot('issue #1234 done', oscLinks)
    await settle()
    setLine('issue plain done')

    fireTouch('touchstart', [{ x: screenXForCol(7), y: tapY }])
    fireTouch('touchend', [])

    expect(posted.find((m) => m.type === 'open-url')).toBeUndefined()
  })

  it('does not post open-url for a scroll gesture past the tap slop', async () => {
    const { posted } = boot(URL_LINE)
    await settle()
    fireTouch('touchstart', [{ x: tapX, y: tapY }])
    fireTouch('touchmove', [{ x: tapX, y: tapY + 120 }])
    fireTouch('touchend', [])
    expect(posted.find((m) => m.type === 'open-url')).toBeUndefined()
  })
})
