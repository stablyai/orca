// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { terminalDocumentDouble } from './document/document-terminal-double.test-support'
import type { TerminalDocumentTerminal } from './document/document-terminal-shape'
import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'

type BufferState = { baseY: number; type: 'alternate' | 'normal'; viewportY: number }

// 40 cols of 8px cells fit a 381px viewport unscaled, so one row is 15 screen px.
const CELL_HEIGHT = 15
const FRAME_MS = 16
const ESC = '\u001b'
const WHEEL_REPORT = new RegExp(`${ESC}\\[<6[45];\\d+;\\d+M`, 'g')

/** Claude Code's reading of xterm.js wheel reports: one alone is a three-row notch. */
function claudeCodeRows(reports: { at: number; count: number; down: boolean }[]) {
  let rows = 0
  let last = Number.NEGATIVE_INFINITY
  for (const { at, count, down } of reports) {
    for (let i = 0; i < count; i++) {
      rows += (down ? 1 : -1) * (at - last > 40 ? 3 : 1)
      last = at
    }
  }
  return rows
}

describe('terminal WebView scroll feel', () => {
  let animationFrames: Array<(frameTime: number) => void>
  let buffer: BufferState
  let modes: { mouseTrackingMode: string }
  let now: number
  let reports: { at: number; count: number; down: boolean; rows: number[] }[]
  let inputs: string[]
  let scrollLines: ReturnType<typeof vi.fn<(lines: number) => void>>
  let presented: ReturnType<typeof vi.fn<(lines: number) => void>>

  function makeTerminal(): TerminalDocumentTerminal {
    let openedOn: HTMLElement | undefined
    return {
      ...terminalDocumentDouble().terminal,
      cols: 40,
      rows: 24,
      modes,
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
      scrollLines,
      beginRemoteScrollPresentation: presented
    }
  }

  function send(data: Record<string, unknown>): void {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
  }

  function boot(): void {
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    new Function(TERMINAL_DOCUMENT_SCRIPT)()
    send({ type: 'init', cols: 40, rows: 24, initialData: '' })
    runFrames(8)
  }

  /** A full-screen program with SGR wheel tracking, as Claude Code and Codex run. */
  function bootWheelProgram(profile: 'claude-code' | 'codex' | 'one-row'): void {
    buffer = { baseY: 0, type: 'alternate', viewportY: 0 }
    boot()
    send({ type: 'write', data: `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h` })
    modes.mouseTrackingMode = 'vt200'
    send({ type: 'set-tui-wheel-profile', profile })
    runFrames(4)
    reports = []
  }

  function runFrames(count: number): void {
    for (let i = 0; i < count && animationFrames.length > 0; i++) {
      now += FRAME_MS
      animationFrames.shift()?.(now)
    }
  }

  function fireTouch(type: string, point: { x: number; y: number } | null): void {
    const surface = document.getElementById('terminal-surface')!
    const event = new Event(type, { bubbles: true, cancelable: true })
    const touches = point
      ? [{ identifier: 0, clientX: point.x, clientY: point.y, target: surface }]
      : []
    Object.defineProperty(event, 'touches', { value: touches })
    Object.defineProperty(event, 'timeStamp', { value: now })
    surface.dispatchEvent(event)
  }

  /** Moves the finger by `stepPx` (positive is up the screen) once per frame. */
  function drag(fromY: number, stepPx: number, steps: number): number {
    let y = fromY
    for (let i = 0; i < steps; i++) {
      y -= stepPx
      now += FRAME_MS
      fireTouch('touchmove', { x: 40, y })
      runFrames(1)
    }
    return y
  }

  function reportCount(): number {
    return reports.reduce((total, report) => total + report.count, 0)
  }

  /** The one-based rows the wheel reports named, as the program reads them. */
  function reportedRows(): number[] {
    return reports.flatMap((report) => report.rows)
  }

  function surfaceOffsetY(): number {
    const transform = document.getElementById('terminal-surface')!.style.transform
    const match = /translate\([^,]+,\s*(-?[\d.e-]+)px\)/.exec(transform)
    return match ? Number(match[1]) : 0
  }

  beforeEach(() => {
    vi.spyOn(window, 'addEventListener')
    vi.spyOn(document, 'addEventListener')
    animationFrames = []
    buffer = { baseY: 500, type: 'normal', viewportY: 500 }
    modes = { mouseTrackingMode: 'none' }
    now = 1_000
    reports = []
    inputs = []
    presented = vi.fn<(lines: number) => void>()
    scrollLines = vi.fn<(lines: number) => void>((lines) => {
      buffer.viewportY = Math.max(0, Math.min(buffer.baseY, buffer.viewportY + lines))
    })
    const postMessage = vi.fn<(data: string) => void>((raw) => {
      const msg = JSON.parse(raw) as { type?: string; bytes?: string }
      if (msg.type !== 'terminal-input' || !msg.bytes) {
        return
      }
      inputs.push(msg.bytes)
      const found = msg.bytes.match(WHEEL_REPORT) ?? []
      if (found.length > 0) {
        reports.push({
          at: now,
          count: found.length,
          down: found[0]!.startsWith(`${ESC}[<65`),
          rows: found.map((report) => Number(report.slice(0, -1).split(';')[2]))
        })
      }
    })
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
        return makeTerminal()
      },
      ReactNativeWebView: { postMessage }
    })
  })

  afterEach(() => {
    for (const [type, listener, options] of vi.mocked(window.addEventListener).mock.calls) {
      window.removeEventListener(type, listener, options)
    }
    for (const [type, listener, options] of vi.mocked(document.addEventListener).mock.calls) {
      document.removeEventListener(type, listener, options)
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('moves Claude Code as far as a slow drag instead of three rows per row', () => {
    bootWheelProgram('claude-code')
    fireTouch('touchstart', { x: 40, y: 400 })
    // 90px of travel at 1px a frame is six rows, far slower than Claude Code's flood gap.
    drag(400, 1, 90)
    expect(reportCount()).toBe(2)
    expect(claudeCodeRows(reports)).toBe(6)
  })

  it('delivers travel held by Claude Code pacing when the finger rests', () => {
    bootWheelProgram('claude-code')
    fireTouch('touchstart', { x: 40, y: 400 })
    now += 16
    fireTouch('touchmove', { x: 40, y: 355 })
    expect(claudeCodeRows(reports)).toBe(3)
    now += 32
    fireTouch('touchmove', { x: 40, y: 325 })
    expect(claudeCodeRows(reports)).toBe(3)
    // No further movement: the withheld two rows must not wait for another touchmove.
    runFrames(20)
    expect(claudeCodeRows(reports)).toBe(6)
    now += 200
    fireTouch('touchend', null)
    runFrames(100)
    expect(claudeCodeRows(reports)).toBe(6)
  })

  it('takes back deferred reports when a new touch lands', () => {
    bootWheelProgram('claude-code')
    fireTouch('touchstart', { x: 40, y: 400 })
    now += 16
    fireTouch('touchmove', { x: 40, y: 355 })
    now += 32
    fireTouch('touchmove', { x: 40, y: 325 })
    fireTouch('touchstart', { x: 40, y: 325 })
    runFrames(100)
    expect(claudeCodeRows(reports)).toBe(3)
  })

  it('keeps one report per row for a program that moves one row per report', () => {
    bootWheelProgram('one-row')
    fireTouch('touchstart', { x: 40, y: 400 })
    drag(400, 1, 90)
    expect(reportCount()).toBe(6)
  })

  // 24 rows of 15px: below y 180 the finger is past the middle row 12, on Codex's composer side.
  it('reports a Codex drag that starts on its composer from the middle row', () => {
    bootWheelProgram('codex')
    fireTouch('touchstart', { x: 40, y: 350 })
    drag(350, 1, 90)
    expect(reportCount()).toBe(6)
    expect(new Set(reportedRows())).toEqual(new Set([12]))
  })

  it('keeps a Codex coast lifted on its composer reporting from the middle row', () => {
    bootWheelProgram('codex')
    fireTouch('touchstart', { x: 40, y: 170 })
    drag(170, -30, 6)
    fireTouch('touchend', null)
    runFrames(400)
    expect(reportCount()).toBeGreaterThan(20)
    expect(new Set(reportedRows())).toEqual(new Set([12]))
  })

  it('reports where the finger is over Codex history', () => {
    bootWheelProgram('codex')
    fireTouch('touchstart', { x: 40, y: 60 })
    drag(60, -1, 45)
    expect(reportCount()).toBe(3)
    expect(reportedRows().every((row) => row >= 5 && row <= 8)).toBe(true)
  })

  it('reports where the finger is for a program that reads reports on any row', () => {
    bootWheelProgram('one-row')
    fireTouch('touchstart', { x: 40, y: 350 })
    drag(350, 1, 90)
    expect(Math.min(...reportedRows())).toBeGreaterThan(12)
  })

  it('tracks a fast Claude Code drag row for row', () => {
    bootWheelProgram('claude-code')
    fireTouch('touchstart', { x: 40, y: 400 })
    // 300px at 30px a frame is twenty rows.
    drag(400, 30, 10)
    expect(claudeCodeRows(reports)).toBe(20)
  })

  it('ends a Claude Code coast without running three rows ahead per report', () => {
    bootWheelProgram('claude-code')
    fireTouch('touchstart', { x: 40, y: 400 })
    const y = drag(400, 30, 6)
    const fingerRows = (400 - y) / CELL_HEIGHT
    fireTouch('touchend', null)
    runFrames(400)
    expect(animationFrames).toHaveLength(0)
    // The coast adds rows, and every report it sent is one Claude Code moves as planned.
    const coastRows = claudeCodeRows(reports) - fingerRows
    expect(coastRows).toBeGreaterThan(10)
    const gaps = reports.slice(1).map((report, index) => report.at - reports[index]!.at)
    expect(gaps.every((gap) => gap <= 22 || gap > 52)).toBe(true)
    const plannedRows = reports.reduce(
      (total, report, index) =>
        total + report.count + (index === 0 || gaps[index - 1]! > 52 ? 2 : 0),
      0
    )
    expect(claudeCodeRows(reports)).toBe(plannedRows)
  })

  it('pulls the content past the newest row on a rubber band and springs it back', () => {
    boot()
    fireTouch('touchstart', { x: 40, y: 400 })
    drag(400, 20, 5)
    const pulled = surfaceOffsetY()
    // 100px of pull shows as less than that, toward the top of the screen.
    expect(pulled).toBeLessThan(-20)
    expect(pulled).toBeGreaterThan(-100)
    expect(scrollLines).not.toHaveBeenCalled()
    fireTouch('touchend', null)
    runFrames(60)
    expect(surfaceOffsetY()).toBe(0)
    expect(animationFrames).toHaveLength(0)
  })

  it('eases a pull before scrolling back through the buffer', () => {
    boot()
    fireTouch('touchstart', { x: 40, y: 400 })
    const y = drag(400, 20, 3)
    expect(surfaceOffsetY()).toBeLessThan(0)
    // 100px back down: 60 undo the pull and the other 40 are two whole rows of scrollback.
    drag(y, -20, 5)
    expect(surfaceOffsetY()).toBe(0)
    expect(scrollLines.mock.calls.reduce((total, [lines]) => total + lines, 0)).toBe(-2)
  })

  it('bounces a coast off the end of the buffer instead of stopping dead', () => {
    buffer = { baseY: 500, type: 'normal', viewportY: 495 }
    boot()
    fireTouch('touchstart', { x: 40, y: 400 })
    drag(400, 40, 4)
    fireTouch('touchend', null)
    let deepest = 0
    for (let i = 0; i < 120 && animationFrames.length > 0; i++) {
      runFrames(1)
      deepest = Math.min(deepest, surfaceOffsetY())
    }
    expect(buffer.viewportY).toBe(500)
    expect(deepest).toBeLessThan(-5)
    expect(surfaceOffsetY()).toBe(0)
    expect(animationFrames).toHaveLength(0)
  })

  function scrolledRows(): number {
    return scrollLines.mock.calls.reduce((total, [lines]) => total + lines, 0)
  }

  /** A shell's scrollback mid-history, or an alternate-screen program fed arrow keys. */
  function bootRestingCase(type: 'normal' | 'alternate'): void {
    buffer = { baseY: 500, type, viewportY: 100 }
    boot()
  }

  it.each([
    ['normal', 1],
    ['alternate', 1],
    ['alternate', 0]
  ] as const)('does not revive a rested %s coast after %dpx of jitter', (type, jitter) => {
    bootRestingCase(type)
    fireTouch('touchstart', { x: 40, y: 400 })
    const y = drag(400, 20, 5)
    now += 500
    fireTouch('touchmove', { x: 41, y: y - jitter })
    runFrames(1)
    const rows = scrolledRows()
    const sent = inputs.join('')
    fireTouch('touchend', null)
    runFrames(60)
    expect(scrolledRows()).toBe(rows)
    expect(inputs.join('')).toBe(sent)
  })

  it.each(['normal', 'alternate'] as const)('allows a new %s flick after a rest', (type) => {
    bootRestingCase(type)
    fireTouch('touchstart', { x: 40, y: 400 })
    const y = drag(400, 20, 5)
    now += 500
    fireTouch('touchmove', { x: 40, y: y - 1 })
    now += 16
    fireTouch('touchmove', { x: 40, y: y - 41 })
    runFrames(1)
    const before = type === 'normal' ? scrolledRows() : inputs.join('').length
    fireTouch('touchend', null)
    runFrames(30)
    expect(type === 'normal' ? scrolledRows() : inputs.join('').length).toBeGreaterThan(before)
  })

  it.each(['one-row', 'codex'] as const)(
    'asks the renderer to present each %s wheel write it sends a program',
    (profile) => {
      bootWheelProgram(profile)
      fireTouch('touchstart', { x: 40, y: 400 })
      drag(400, 30, 4)
      // Each write names the rows the finger moved, toward the newest row as a positive count.
      expect(presented.mock.calls.map(([lines]) => lines)).toEqual(reports.map((r) => r.count))
      expect(presented).toHaveBeenCalledTimes(reports.length)
    }
  )

  it('asks the renderer to present arrow scrolling sent to an alternate-screen program', () => {
    bootRestingCase('alternate')
    fireTouch('touchstart', { x: 40, y: 400 })
    drag(400, 30, 2)
    expect(presented.mock.calls.map(([lines]) => lines)).toEqual([2, 2])
  })

  it('leaves scrollback of the normal buffer to the renderer of its own', () => {
    bootRestingCase('normal')
    fireTouch('touchstart', { x: 40, y: 400 })
    drag(400, 30, 2)
    expect(scrolledRows()).toBe(4)
    expect(presented).not.toHaveBeenCalled()
  })
})
