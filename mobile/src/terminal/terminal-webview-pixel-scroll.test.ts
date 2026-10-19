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

describe('terminal WebView pixel scrolling of the normal buffer', () => {
  let frames: { id: number; callback: (frameTime: number) => void }[]
  let nextFrameId: number
  let buffer: BufferState
  let bufferChanged: (() => void)[]
  let now: number
  let offset: ReturnType<typeof vi.fn<(value: number) => boolean>>
  let postMessage: ReturnType<typeof vi.fn<(data: string) => void>>
  let scrollLines: ReturnType<typeof vi.fn<(lines: number) => void>>

  /** The engine as the WebView loads it, with the smooth renderer's offset seam. */
  function makeTerminal(): TerminalDocumentTerminal {
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
        },
        onBufferChange(listener: () => void) {
          bufferChanged.push(listener)
          return { dispose() {} }
        }
      },
      get element() {
        return openedOn
      },
      open(surface: HTMLElement) {
        openedOn = surface
      },
      scrollLines,
      setViewportPixelOffset: offset
    }
  }

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
    for (let i = 0; i < count && frames.length > 0; i++) {
      now += FRAME_MS
      frames.shift()?.callback(now)
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

  const drawnOffset = () => offset.mock.calls.at(-1)?.[0]

  beforeEach(() => {
    vi.spyOn(window, 'addEventListener')
    vi.spyOn(document, 'addEventListener')
    frames = []
    nextFrameId = 0
    buffer = { baseY: 500, type: 'normal', viewportY: 100 }
    bufferChanged = []
    now = 1_000
    offset = vi.fn((_value: number) => true)
    postMessage = vi.fn<(data: string) => void>()
    scrollLines = vi.fn<(lines: number) => void>((lines) => {
      buffer.viewportY += lines
    })
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: (frameTime: number) => void) => {
      frames.push({ id: ++nextFrameId, callback })
      return nextFrameId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames = frames.filter((frame) => frame.id !== id)
    })
    Object.defineProperty(window, 'innerWidth', { value: 381, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 612, configurable: true })
    Object.assign(window, { Terminal: makeTerminal, ReactNativeWebView: { postMessage } })
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const [type, listener, options] of vi.mocked(window.addEventListener).mock.calls) {
      window.removeEventListener(type, listener, options)
    }
    for (const [type, listener, options] of vi.mocked(document.addEventListener).mock.calls) {
      document.removeEventListener(type, listener, options)
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps small finger jitter still without momentum', () => {
    boot()
    fireTouch('touchstart', { x: 40, y: 400 })
    dragUp(400, 3, 1)
    fireTouch('touchend', null)
    runFrames(60)
    expect(scrolledRows()).toBe(0)
    expect(offset.mock.calls.length).toBeGreaterThan(0)
    expect(offset.mock.calls.every(([value]) => value === 0)).toBe(true)
  })

  it('follows sub-row travel once the drag has left its start', () => {
    boot()
    fireTouch('touchstart', { x: 40, y: 400 })
    const y = dragUp(400, 3, 3)
    runFrames(8)
    expect(drawnOffset()).toBe(-9)
    dragUp(y, 3, 1)
    runFrames(8)
    expect(drawnOffset()).toBe(-12)
    expect(scrolledRows()).toBe(0)
  })

  it('commits whole rows to xterm and draws only the remainder', () => {
    boot()
    fireTouch('touchstart', { x: 40, y: 400 })
    const y = dragUp(400, 9, 1)
    dragUp(y, 11, 1)
    // 20px of travel over 15px rows.
    expect(scrolledRows()).toBe(1)
    expect(drawnOffset()).toBe(-5)
  })

  it('rests on whole rows at the live bottom', () => {
    buffer.viewportY = buffer.baseY - 1
    boot()
    fireTouch('touchstart', { x: 40, y: 400 })
    const y = dragUp(400, 9, 1)
    dragUp(y, 11, 1)
    expect(buffer.viewportY).toBe(buffer.baseY)
    expect(drawnOffset()).toBe(0)
  })

  it('keeps drawing sub-row offsets while a released flick coasts', () => {
    boot()
    fireTouch('touchstart', { x: 40, y: 400 })
    dragUp(400, 20, 5)
    fireTouch('touchend', null)
    const drawnAtRelease = offset.mock.calls.length
    runFrames(30)
    const coasted = offset.mock.calls.slice(drawnAtRelease).map(([value]) => value)
    expect(scrolledRows()).toBeGreaterThan(6)
    expect(coasted.some((value) => value < 0 && value > -CELL_HEIGHT)).toBe(true)
  })

  it('cancels the selection long press once a pixel drag starts', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boot()
    // Observe this gesture after init has reset the selection state.
    postMessage.mockClear()
    fireTouch('touchstart', { x: 40, y: 400 })
    dragUp(400, 3, 3)
    runFrames(8)
    expect(drawnOffset()).toBe(-9)
    vi.advanceTimersByTime(500)
    expect(document.getElementById('selection-overlay')!.classList.contains('active')).toBe(false)
    expect(postMessage.mock.calls.some(([raw]) => JSON.parse(raw).type === 'set-select-mode')).toBe(
      false
    )
  })

  it.each(['clear', 'alternate screen'])('drops the drawn fraction on %s', (cause) => {
    boot()
    fireTouch('touchstart', { x: 40, y: 400 })
    dragUp(400, 9, 1)
    expect(drawnOffset()).toBe(-9)
    if (cause === 'clear') {
      window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'clear' }) }))
    } else {
      buffer.type = 'alternate'
      for (const listener of bufferChanged) {
        listener()
      }
    }
    expect(drawnOffset()).toBe(0)
  })

  it('lets a touch that stops a program scroll slide only stop it, then taps again', () => {
    let caught = true
    Object.assign(window, {
      Terminal: function () {
        return Object.assign(makeTerminal(), {
          consumeRemoteScrollTouchCatch() {
            const value = caught
            caught = false
            return value
          }
        })
      }
    })
    boot()
    postMessage.mockClear()
    const taps = () =>
      postMessage.mock.calls.filter(([raw]) => JSON.parse(raw).type === 'terminal-tap')
    fireTouch('touchstart', { x: 40, y: 400 })
    now += 16
    fireTouch('touchend', null)
    expect(taps()).toHaveLength(0)
    fireTouch('touchstart', { x: 40, y: 400 })
    now += 16
    fireTouch('touchend', null)
    expect(taps()).toHaveLength(1)
  })
})
