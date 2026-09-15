// @vitest-environment happy-dom
// Exercises the press-and-hold touch loupe end-to-end inside the composed
// XTERM_HTML document: the bubble must appear above a held finger, magnify
// the cells under it from the buffer, follow the finger live, and leave the
// existing tap/selection pipeline untouched.
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

type CellPatch = {
  chars?: string
  width?: number
  fg?: { mode: 'rgb'; value: number } | { mode: 'palette'; index: number }
  bg?: { mode: 'rgb'; value: number } | { mode: 'palette'; index: number }
  bold?: boolean
  inverse?: boolean
  invisible?: boolean
}
type CellPatches = Record<string, CellPatch>

type TerminalState = {
  viewportY: number
  cursorX: number
  cursorY: number
  lines: string[]
  patches: CellPatches
}

function makeCell(state: TerminalState, row: number, col: number) {
  const patch = state.patches[row + ':' + col] ?? {}
  const chars = patch.chars ?? state.lines[row]?.[col] ?? ' '
  return {
    getWidth: () => patch.width ?? 1,
    getChars: () => chars,
    getFgColor: () => patch.fg?.value ?? patch.fg?.index ?? 0,
    getBgColor: () => patch.bg?.value ?? patch.bg?.index ?? 0,
    isFgDefault: () => patch.fg === undefined,
    isBgDefault: () => patch.bg === undefined,
    isFgRGB: () => patch.fg?.mode === 'rgb',
    isBgRGB: () => patch.bg?.mode === 'rgb',
    isFgPalette: () => patch.fg?.mode === 'palette',
    isBgPalette: () => patch.bg?.mode === 'palette',
    isBold: () => (patch.bold ? 1 : 0),
    isInverse: () => (patch.inverse ? 1 : 0),
    isInvisible: () => (patch.invisible ? 1 : 0)
  }
}

function makeTerminal(state: TerminalState) {
  return {
    cols: 80,
    rows: 40,
    options: { fontSize: 13 },
    modes: { mouseTrackingMode: 'none' },
    element: { scrollWidth: 640, scrollHeight: 600 },
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } },
    buffer: {
      active: {
        get viewportY() {
          return state.viewportY
        },
        get cursorX() {
          return state.cursorX
        },
        get cursorY() {
          return state.cursorY
        },
        baseY: 16,
        length: state.lines.length,
        type: 'normal',
        getLine(row: number) {
          if (row < 0 || row >= state.lines.length) {
            return null
          }
          return {
            getCell: (col: number) =>
              col >= 0 && col < 80 ? makeCell(state, row, col) : undefined,
            // Honor (trim, start, end) like real xterm so cell->string-index
            // conversion resolves correctly.
            translateToString: (_trim?: boolean, start?: number, end?: number) =>
              state.lines[row].slice(start ?? 0, end ?? state.lines[row].length)
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

type CtxCall = { op: string; args: unknown[]; fillStyle: unknown }

type LoupeHarness = {
  ctxCalls: CtxCall[]
  fillTextChars: () => string[]
  flushFrames: (batches?: number) => void
  fireTouch: (type: string, points: Array<{ x: number; y: number }>, targetId?: string) => void
  loupeEl: () => HTMLElement
  canvas: () => HTMLCanvasElement
  posted: Array<Record<string, unknown>>
  setState: (mutate: (state: TerminalState) => void) => void
  postMessage: (msg: Record<string, unknown>) => void
}

function bootLoupeHarness(lines: string[], patches: CellPatches = {}): LoupeHarness {
  const state: TerminalState = { viewportY: 0, cursorX: 0, cursorY: 0, lines, patches }
  const frames: Array<{ fn: () => void; id: number; canceled: boolean }> = []
  let frameSeq = 0
  const ctxCalls: CtxCall[] = []
  const ctxTarget: Record<string, unknown> = {}
  const posted: Array<Record<string, unknown>> = []
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frameSeq += 1
    frames.push({ fn: callback, id: frameSeq, canceled: false })
    return frameSeq
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    const frame = frames.find((f) => f.id === id)
    if (frame) {
      frame.canceled = true
    }
  })
  const recordingCtx = new Proxy(ctxTarget, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) {
        return target[prop]
      }
      return (...args: unknown[]) => {
        ctxCalls.push({ op: String(prop), args, fillStyle: target.fillStyle })
      }
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  // Why: happy-dom cannot provide a real 2d context, and a vi.spyOn return
  // mock would force a type cast — installing an untyped getter keeps the
  // recorder cast-free while still answering the loupe's getContext call.
  const canvasProto = window.HTMLCanvasElement.prototype
  if (!originalGetContextDescriptor) {
    originalGetContextDescriptor = Object.getOwnPropertyDescriptor(canvasProto, 'getContext')
  }
  Object.defineProperty(canvasProto, 'getContext', {
    value: () => recordingCtx,
    configurable: true
  })
  vi.stubGlobal('Terminal', function () {
    return makeTerminal(state)
  })
  vi.stubGlobal('ReactNativeWebView', {
    postMessage(s: string) {
      posted.push(JSON.parse(s))
    }
  })
  document.body.innerHTML = bodyMarkup()
  new Function(iifeSource())()
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'init', cols: 80, rows: 24, initialData: '' })
    })
  )
  while (frames.length > 0) {
    frames.shift()?.fn()
  }
  return {
    ctxCalls,
    fillTextChars: () => ctxCalls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0])),
    flushFrames: (batches = 1) => {
      for (let i = 0; i < batches; i++) {
        const pending = frames.splice(0).filter((f) => !f.canceled)
        for (const frame of pending) {
          frame.fn()
        }
      }
    },
    fireTouch: (type, points, targetId = 'terminal-surface') => {
      const target = targetId === 'terminal-surface' ? requireSurface() : requireEl(targetId)
      const ev = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'touches', {
        value: points.map((p, i) => ({ identifier: i, clientX: p.x, clientY: p.y, target }))
      })
      Object.defineProperty(ev, 'target', { value: target })
      document.dispatchEvent(ev)
    },
    loupeEl: () => requireEl('touch-loupe'),
    canvas: () => requireCanvas(),
    posted,
    setState: (mutate) => mutate(state),
    postMessage: (msg) => {
      window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }))
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let originalGetContextDescriptor: PropertyDescriptor | undefined

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!(el instanceof HTMLElement)) {
    throw new Error('missing #' + id)
  }
  return el
}

function requireSurface(): HTMLElement {
  // Why: earlier IIFE boots leave live message listeners that re-init on this
  // boot's init message and append their own surfaces first; the current
  // closure's surface is always the container's last child.
  const el = document.querySelector('#terminal-container > div:last-child')
  if (!(el instanceof HTMLElement)) {
    throw new Error('terminal surface missing')
  }
  return el
}

function requireCanvas(): HTMLCanvasElement {
  const el = document.getElementById('touch-loupe-canvas')
  if (!(el instanceof HTMLCanvasElement)) {
    throw new Error('loupe canvas missing')
  }
  return el
}

// Fit scale is min(1, 390 / (8*80)) = 0.609375; surface px per col = 4.875, per row = 9.140625.
const xForCol = (col: number): number => col * 8 * 0.609375
const yForRow = (row: number): number => row * 15 * 0.609375

describe('terminal WebView touch loupe', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true })
  })

  afterEach(() => {
    if (originalGetContextDescriptor) {
      Object.defineProperty(
        window.HTMLCanvasElement.prototype,
        'getContext',
        originalGetContextDescriptor
      )
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows the magnifier above a held finger and sizes its canvas', async () => {
    const h = bootLoupeHarness(Array.from({ length: 40 }, (_, r) => `row ${r} alpha beta`))
    h.fireTouch('touchstart', [{ x: xForCol(3), y: yForRow(32) }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    expect(h.canvas().width).toBe(272) // 17 cols * 8px * zoom 2
    expect(h.canvas().height).toBe(150) // 5 rows * 15px * zoom 2
    // Finger at col 3 of a 17-col region clamps the window to cols 0-16.
    expect(h.loupeEl().style.left).toBe('8px')
    expect(h.loupeEl().style.top).toBe('66.5px')
    expect(h.fillTextChars().join('')).toContain('row 32')
    h.fireTouch('touchend', [])
    expect(h.loupeEl().style.display).toBe('none')
  })

  it('never flashes on a quick tap', async () => {
    const h = bootLoupeHarness(['hello'])
    h.fireTouch('touchstart', [{ x: 100, y: 100 }])
    h.fireTouch('touchend', [])
    await sleep(220)
    expect(h.loupeEl().style.display).not.toBe('block')
    expect(h.ctxCalls).toHaveLength(0)
  })

  it('shows immediately on a selection-handle drag after long-press select', async () => {
    const h = bootLoupeHarness(Array.from({ length: 40 }, (_, r) => `row ${r} alpha beta`))
    h.fireTouch('touchstart', [{ x: xForCol(5), y: yForRow(10) }])
    await vi.waitFor(() =>
      expect(h.posted.find((m) => m.type === 'set-select-mode' && m.enabled === true)).toBeTruthy()
    )
    h.fireTouch('touchend', [])
    h.fireTouch('touchstart', [{ x: xForCol(5), y: yForRow(10) }], 'sel-handle-end')
    expect(h.loupeEl().style.display).toBe('block')
    h.flushFrames()
    expect(h.ctxCalls.length).toBeGreaterThan(0)
    // The seeded word selection must highlight with the theme selection color.
    expect(h.ctxCalls.some((c) => c.op === 'fillRect' && c.fillStyle === 'rgb(51,70,124)')).toBe(
      true
    )
    h.fireTouch('touchend', [])
  })

  it('hides when a second finger lands and never draws for menu taps', async () => {
    const h = bootLoupeHarness(['menu time'])
    h.fireTouch('touchstart', [{ x: 100, y: 300 }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    expect(h.ctxCalls.length).toBeGreaterThan(0)
    const drawn = h.ctxCalls.length
    h.fireTouch('touchstart', [
      { x: 100, y: 300 },
      { x: 200, y: 400 }
    ])
    expect(h.loupeEl().style.display).toBe('none')
    h.fireTouch('touchend', [])
    h.fireTouch('touchstart', [{ x: 100, y: 100 }], 'sel-menu-copy')
    await sleep(220)
    expect(h.ctxCalls).toHaveLength(drawn)
    h.fireTouch('touchend', [])
  })

  it('follows the finger across a scroll by redrawing the cells beneath it', async () => {
    const h = bootLoupeHarness(Array.from({ length: 40 }, (_, r) => `row ${r} alpha beta`))
    h.fireTouch('touchstart', [{ x: xForCol(3), y: yForRow(32) }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    expect(h.fillTextChars().join('')).toContain('row 32')
    h.setState((s) => {
      s.viewportY = 4
    })
    h.flushFrames()
    expect(h.fillTextChars().join('')).toContain('row 36')
    h.fireTouch('touchend', [])
  })

  it('renders cell colors from palette and truecolor cells', async () => {
    const patches: CellPatches = {
      '10:5': { fg: { mode: 'palette', index: 1 } },
      '10:8': { fg: { mode: 'rgb', value: 0x0c2238 } }
    }
    const h = bootLoupeHarness(
      Array.from({ length: 40 }, () => 'color me impressed'),
      patches
    )
    h.fireTouch('touchstart', [{ x: xForCol(8), y: yForRow(10) }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    const fills = h.ctxCalls.filter((c) => c.op === 'fillText')
    expect(fills.some((c) => c.fillStyle === 'rgb(247,118,142)')).toBe(true)
    expect(fills.some((c) => c.fillStyle === 'rgb(12,34,56)')).toBe(true)
    h.fireTouch('touchend', [])
  })

  it('keeps routing surface taps to URLs while installed', async () => {
    const h = bootLoupeHarness(['visit https://example.com/foo now'])
    await sleep(60)
    h.fireTouch('touchstart', [{ x: xForCol(12), y: yForRow(0) }])
    h.fireTouch('touchend', [])
    expect(h.posted.find((m) => m.type === 'open-url')?.url).toBe('https://example.com/foo')
  })

  it('clamps to the screen edges and flips below the finger near the top', async () => {
    const h = bootLoupeHarness(Array.from({ length: 40 }, (_, r) => `row ${r} alpha beta`))
    // Near the top edge and the right edge: bubble flips below and clamps left... right.
    h.fireTouch('touchstart', [{ x: xForCol(75), y: yForRow(2) }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    expect(h.loupeEl().style.left).toBe('110px') // clamped to viewportW - w - 8
    expect(h.loupeEl().style.top).toBe('94.28125px') // yForRow(2) + 76, flipped below
    h.fireTouch('touchend', [])
  })

  it('windows the region to the grid edges under the finger', async () => {
    const alphabet = Array.from({ length: 80 }, (_, c) => String.fromCharCode(65 + (c % 26)))
    const h = bootLoupeHarness([alphabet.join('')])
    const charsFor = (from: number, count: number): string =>
      alphabet.slice(from, from + count).join('')
    h.fireTouch('touchstart', [{ x: xForCol(79), y: yForRow(0) }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    expect(h.fillTextChars().join('')).toBe(charsFor(63, 17))
    h.fireTouch('touchend', [])
    h.ctxCalls.length = 0
    h.fireTouch('touchstart', [{ x: xForCol(0), y: yForRow(0) }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    expect(h.fillTextChars().join('')).toBe(charsFor(0, 17))
    h.fireTouch('touchend', [])
  })

  it('draws a wide char once across both of its cells', async () => {
    const patches: CellPatches = {
      '12:5': { chars: '漢', width: 2 },
      '12:6': { width: 0, chars: '' }
    }
    const h = bootLoupeHarness(
      Array.from({ length: 40 }, () => 'wide char line here'),
      patches
    )
    h.fireTouch('touchstart', [{ x: xForCol(5), y: yForRow(12) }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    expect(h.fillTextChars().filter((c) => c === '漢')).toHaveLength(1)
    h.fireTouch('touchend', [])
  })

  it('marks the cursor cell with an accent bar', async () => {
    const h = bootLoupeHarness(Array.from({ length: 40 }, (_, r) => `row ${r} alpha beta`))
    h.setState((s) => {
      s.cursorX = 3
      s.cursorY = 12
    })
    h.fireTouch('touchstart', [{ x: xForCol(3), y: yForRow(12) }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    // Region rows 10-14, cols 0-16: cursor at (3,12) draws a 2px bar at x 3*16, y 2*30.
    expect(
      h.ctxCalls.some(
        (c) =>
          c.op === 'fillRect' &&
          c.fillStyle === 'rgb(192,202,245)' &&
          c.args.join(',') === '48,60,2,30'
      )
    ).toBe(true)
    h.fireTouch('touchend', [])
  })

  it('keeps drawing across a re-init while the finger stays down', async () => {
    const h = bootLoupeHarness(Array.from({ length: 40 }, (_, r) => `row ${r} alpha beta`))
    h.fireTouch('touchstart', [{ x: xForCol(3), y: yForRow(32) }])
    await vi.waitFor(() => expect(h.loupeEl().style.display).toBe('block'))
    h.flushFrames()
    h.postMessage({ type: 'init', cols: 80, rows: 40, initialData: '' })
    h.flushFrames()
    expect(h.loupeEl().style.display).toBe('block')
    expect(h.posted.some((m) => m.type === 'engine-error')).toBe(false)
    h.fireTouch('touchend', [])
    expect(h.loupeEl().style.display).toBe('none')
  })
})
