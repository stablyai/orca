// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { terminalDocumentDouble } from './document/document-terminal-double.test-support'
import type { TerminalDocumentTerminal } from './document/document-terminal-shape'
import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'

type BufferState = {
  baseY: number
  type: 'alternate' | 'normal'
  viewportY: number
}

// 40 cols of 8px cells fit a 381px viewport unscaled, so one row is 15 screen px.
const CELL_HEIGHT = 15
const FRAME_MS = 16
const ESC_ARROW_DOWN = '\u001b[B'

function makeTerminal(
  buffer: BufferState,
  scrollLines: (lines: number) => void
): TerminalDocumentTerminal {
  let openedOn: HTMLElement | undefined
  return {
    ...terminalDocumentDouble().terminal,
    cols: 40,
    rows: 24,
    modes: { mouseTrackingMode: 'none' },
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
        getLine: () => undefined
      }
    },
    get element() {
      return openedOn
    },
    open(surface: HTMLElement) {
      openedOn = surface
    },
    scrollLines
  }
}

describe('terminal WebView touch scrolling', () => {
  let animationFrames: Array<(frameTime: number) => void>
  let buffer: BufferState
  let now: number
  let postMessage: ReturnType<typeof vi.fn<(data: string) => void>>
  let scrollLines: ReturnType<typeof vi.fn<(lines: number) => void>>

  function boot(): void {
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    // The bundle the WebView loads, run as the WebView runs it.
    new Function(TERMINAL_DOCUMENT_SCRIPT)()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'init', cols: 40, rows: 24, initialData: '' })
      })
    )
    // Why: init commits the replacement surface on the next animation frame.
    runFrames(8)
  }

  function runFrames(count: number): void {
    for (let i = 0; i < count && animationFrames.length > 0; i++) {
      now += FRAME_MS
      animationFrames.shift()?.(now)
    }
  }

  function fireTouch(type: string, point: { x: number; y: number } | null): void {
    const surface = document.getElementById('terminal-surface')
    if (!surface) {
      throw new Error('terminal surface missing')
    }
    const event = new Event(type, { bubbles: true, cancelable: true })
    const touches = point
      ? [{ identifier: 0, clientX: point.x, clientY: point.y, target: surface }]
      : []
    Object.defineProperty(event, 'touches', { value: touches })
    surface.dispatchEvent(event)
  }

  /** A finger moving up the screen, one touchmove per frame; returns where it ended. */
  function dragUp(fromY: number, stepPx: number, steps: number): number {
    let y = fromY
    for (let i = 0; i < steps; i++) {
      y -= stepPx
      now += FRAME_MS
      fireTouch('touchmove', { x: 40, y })
      runFrames(1)
    }
    return y
  }

  function scrolledRows(): number {
    return scrollLines.mock.calls.reduce((total, [lines]) => total + lines, 0)
  }

  function terminalInputBytes(): string {
    return postMessage.mock.calls
      .map(([raw]): { bytes?: string; type?: string } => JSON.parse(raw))
      .filter((msg) => msg.type === 'terminal-input')
      .map((msg) => msg.bytes ?? '')
      .join('')
  }

  beforeEach(() => {
    animationFrames = []
    buffer = { baseY: 500, type: 'normal', viewportY: 100 }
    now = 1_000
    scrollLines = vi.fn<(lines: number) => void>()
    postMessage = vi.fn<(data: string) => void>()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: (frameTime: number) => void) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      animationFrames = []
    })
    Object.defineProperty(window, 'innerWidth', { value: 381, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 612, configurable: true })
    Object.assign(window, {
      Terminal: function () {
        return makeTerminal(buffer, scrollLines)
      },
      ReactNativeWebView: { postMessage }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('scrolls scrollback for a drag slower than one pixel per frame', () => {
    boot()

    fireTouch('touchstart', { x: 40, y: 400 })
    dragUp(400, 0.5, 200)

    // 100px of travel over 15px rows.
    expect(scrolledRows()).toBe(6)
  })

  it('carries the sub-row remainder of a fast drag into the next move', () => {
    boot()

    fireTouch('touchstart', { x: 40, y: 400 })
    const y = dragUp(400, 100, 1)
    expect(scrolledRows()).toBe(6)

    // 10px left over from the first move plus 5px more is one more row.
    dragUp(y, 5, 1)
    expect(scrolledRows()).toBe(7)
  })

  it('coasts when the finger lifts mid-drag', () => {
    boot()

    fireTouch('touchstart', { x: 40, y: 400 })
    dragUp(400, 20, 5)
    const rowsWhileTouching = scrolledRows()
    fireTouch('touchend', null)
    runFrames(30)

    expect(scrolledRows()).toBeGreaterThan(rowsWhileTouching)
  })

  it('does not coast when the finger rested before lifting', () => {
    boot()

    fireTouch('touchstart', { x: 40, y: 400 })
    dragUp(400, 20, 5)
    const rowsWhileTouching = scrolledRows()
    now += 500
    fireTouch('touchend', null)
    runFrames(30)

    expect(scrolledRows()).toBe(rowsWhileTouching)
  })

  it('does not send a resting finger’s momentum to an alternate-screen app', () => {
    buffer = { baseY: 0, type: 'alternate', viewportY: 0 }
    boot()

    fireTouch('touchstart', { x: 40, y: 400 })
    dragUp(400, 20, 5)
    const bytesWhileTouching = terminalInputBytes()
    expect(bytesWhileTouching).toContain(ESC_ARROW_DOWN)
    now += 500
    fireTouch('touchend', null)
    runFrames(30)

    expect(terminalInputBytes()).toBe(bytesWhileTouching)
  })
})
