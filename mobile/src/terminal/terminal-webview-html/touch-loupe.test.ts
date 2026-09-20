import { Script } from 'node:vm'
import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
import { TERMINAL_WEBVIEW_THEME_JS } from '../terminal-webview-theme-injected'
import { DEFAULT_TERMINAL_THEME } from './theme'
import { TERMINAL_HTML_TOUCH_LOUPE_COLORS } from './touch-loupe-colors'
import { TERMINAL_HTML_TOUCH_LOUPE } from './touch-loupe'

type LoupeListener = (event: Record<string, unknown>) => void
type RecordedTimer = { fn: () => void; ms: number; cleared: boolean }
type LoupeCellProbe = Record<string, () => unknown>

// The fragment's pure decision layer, evaluated in a bare vm context the way
// terminal-webview-theme-injected.test.ts exercises the theme fragment. The
// loupe functions are optional here because the vm script is what defines
// them — a missing function fails the test as a missing export.
type LoupeVmContext = {
  __listeners: Record<string, LoupeListener[]>
  __timers: RecordedTimer[]
  __frames: Array<() => void>
  __loupeEl: { style: { display?: string } }
  __surfaceMarker: { marker: string }
  __handleStartMarker: { marker: string }
  loupeState?: string
  loupePoint?: { x: number; y: number }
  loupeWindow?: (
    centerCol: number,
    centerRow: number,
    cols: number,
    bufferLength: number
  ) => { startCol: number; startRow: number }
  loupeLayout?: (
    pointX: number,
    pointY: number,
    w: number,
    h: number,
    viewportW: number,
    viewportH: number
  ) => { left: number; top: number; above: boolean }
  loupeThemeRgb?: (cssValue: unknown, fallbackRgb: readonly number[]) => number[]
  loupeBuildPalette?: (theme: Record<string, unknown>) => number[][]
  loupeCellColor?: (
    cell: LoupeCellProbe,
    foreground: boolean,
    palette: number[][],
    theme: Record<string, unknown>
  ) => number[]
}

function loadLoupe(): LoupeVmContext {
  const listeners: Record<string, LoupeListener[]> = {}
  const timers: RecordedTimer[] = []
  const frames: Array<() => void> = []
  const loupeStyle: { display?: string } = {}
  const loupeEl = { style: loupeStyle }
  const surfaceMarker = { marker: 'surface' }
  const handleStartMarker = { marker: 'handleStart' }
  const context: LoupeVmContext = {
    __listeners: listeners,
    __timers: timers,
    __frames: frames,
    __loupeEl: loupeEl,
    __surfaceMarker: surfaceMarker,
    __handleStartMarker: handleStartMarker
  }
  const host: Record<string, unknown> = {
    defaultTheme: DEFAULT_TERMINAL_THEME,
    term: null,
    surface: { contains: (target: unknown) => target === surfaceMarker },
    handleStart: handleStartMarker,
    handleEnd: { marker: 'handleEnd' },
    selMode: 'navigate',
    sel: null,
    terminalFontFamily: 'monospace',
    panX: 0,
    panY: 0,
    viewportToCell: () => null,
    getCellWidth: () => 8,
    getCellHeight: () => 15,
    getTotalScale: () => 1,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms, cleared: false })
      return timers.length - 1
    },
    clearTimeout: (id: number) => {
      if (timers[id]) {
        timers[id].cleared = true
      }
    },
    requestAnimationFrame: (fn: () => void) => {
      frames.push(fn)
      return frames.length
    },
    cancelAnimationFrame: () => undefined,
    document: {
      getElementById: (id: string) => (id === 'touch-loupe' ? loupeEl : { style: {} }),
      addEventListener: (type: string, listener: LoupeListener) => {
        ;(listeners[type] ??= []).push(listener)
      }
    },
    window: { innerWidth: 390, innerHeight: 844, devicePixelRatio: 1 }
  }
  Object.assign(context, host)
  new Script(TERMINAL_WEBVIEW_THEME_JS).runInNewContext(context)
  new Script(TERMINAL_HTML_TOUCH_LOUPE_COLORS).runInNewContext(context)
  new Script(TERMINAL_HTML_TOUCH_LOUPE).runInNewContext(context)
  return context
}

function fireLoupe(
  context: LoupeVmContext,
  type: string,
  points: Array<{ x: number; y: number }>,
  target: unknown
): void {
  const listeners = context.__listeners[type] ?? []
  const touches = points.map((p, i) => ({ identifier: i, clientX: p.x, clientY: p.y }))
  for (const listener of listeners) {
    listener({ touches, target })
  }
}

function firePendingTimer(context: LoupeVmContext): void {
  const timer = context.__timers.find((t) => !t.cleared)
  if (!timer) {
    throw new Error('no pending loupe timer')
  }
  timer.fn()
}

function loupeDisplay(context: LoupeVmContext): string | undefined {
  return context.__loupeEl.style.display
}

describe('mobile terminal touch loupe pure layer', () => {
  it('parses at the Chrome 74 syntax floor', () => {
    expect(() => parse(TERMINAL_HTML_TOUCH_LOUPE_COLORS, { ecmaVersion: 2019 })).not.toThrow()
    expect(() => parse(TERMINAL_HTML_TOUCH_LOUPE, { ecmaVersion: 2019 })).not.toThrow()
  })

  it('builds the 256-color palette from the theme ANSI slots', () => {
    const context = loadLoupe()
    const { loupeBuildPalette } = context
    if (!loupeBuildPalette) {
      throw new Error('fragment missing loupeBuildPalette')
    }
    const palette = loupeBuildPalette(DEFAULT_TERMINAL_THEME)
    expect(palette).toHaveLength(256)
    expect(palette[1]).toEqual([247, 118, 142]) // theme red #f7768e
    expect(palette[16]).toEqual([0, 0, 0])
    expect(palette[17]).toEqual([0, 0, 95])
    expect(palette[21]).toEqual([0, 0, 255])
    expect(palette[231]).toEqual([255, 255, 255])
    expect(palette[232]).toEqual([8, 8, 8])
    expect(palette[255]).toEqual([238, 238, 238])
  })

  it('falls back to the xterm defaults for theme keys the theme omits', () => {
    const context = loadLoupe()
    const { loupeBuildPalette } = context
    if (!loupeBuildPalette) {
      throw new Error('fragment missing loupeBuildPalette')
    }
    const palette = loupeBuildPalette({})
    expect(palette[1]).toEqual([204, 0, 0]) // xterm default red #cc0000
  })

  it('resolves cell colors across default, palette, and RGB modes', () => {
    const context = loadLoupe()
    const { loupeBuildPalette, loupeCellColor } = context
    if (!loupeBuildPalette || !loupeCellColor) {
      throw new Error('fragment missing color functions')
    }
    const palette = loupeBuildPalette(DEFAULT_TERMINAL_THEME)
    const rgb = probeCell({ def: false, rgb: true, color: 0x1a1b26 })
    expect(loupeCellColor(rgb, true, palette, DEFAULT_TERMINAL_THEME)).toEqual([26, 27, 38])
    const paletteIdx = probeCell({ def: false, rgb: false, color: 1 })
    expect(loupeCellColor(paletteIdx, true, palette, DEFAULT_TERMINAL_THEME)).toEqual([
      247, 118, 142
    ])
    const def = probeCell({ def: true, rgb: false, color: 0 })
    expect(loupeCellColor(def, true, palette, DEFAULT_TERMINAL_THEME)).toEqual([192, 202, 245])
    expect(loupeCellColor(def, false, palette, DEFAULT_TERMINAL_THEME)).toEqual([26, 27, 38])
  })

  it('composites translucent theme colors over the app surface', () => {
    const context = loadLoupe()
    const { loupeThemeRgb } = context
    if (!loupeThemeRgb) {
      throw new Error('fragment missing loupeThemeRgb')
    }
    expect(loupeThemeRgb('rgba(255,255,255,0.5)', [0, 0, 0])).toEqual([133, 133, 133])
    expect(loupeThemeRgb('#f7768e', [0, 0, 0])).toEqual([247, 118, 142])
    expect(loupeThemeRgb('not-a-color', [7, 8, 9])).toEqual([7, 8, 9])
  })

  it('windows the magnified region around the finger cell with edge clamping', () => {
    const context = loadLoupe()
    const { loupeWindow } = context
    if (!loupeWindow) {
      throw new Error('fragment missing loupeWindow')
    }
    expect(loupeWindow(40, 100, 80, 200)).toEqual({ startCol: 32, startRow: 98 })
    expect(loupeWindow(0, 0, 80, 200)).toEqual({ startCol: 0, startRow: 0 })
    expect(loupeWindow(79, 199, 80, 200)).toEqual({ startCol: 63, startRow: 195 })
    expect(loupeWindow(5, 2, 10, 3)).toEqual({ startCol: 0, startRow: 0 })
  })

  it('places the bubble above the finger and clamps or flips at the edges', () => {
    const context = loadLoupe()
    const { loupeLayout } = context
    if (!loupeLayout) {
      throw new Error('fragment missing loupeLayout')
    }
    expect(loupeLayout(195, 300, 272, 150, 390, 844)).toEqual({ left: 59, top: 74, above: true })
    expect(loupeLayout(2, 300, 272, 150, 390, 844).left).toBe(8)
    expect(loupeLayout(388, 300, 272, 150, 390, 844).left).toBe(110)
    expect(loupeLayout(195, 150, 272, 150, 390, 844)).toEqual({ left: 59, top: 226, above: false })
  })
})

describe('mobile terminal touch loupe state machine', () => {
  it('shows the loupe only after the press-and-hold delay on the surface', () => {
    const context = loadLoupe()
    fireLoupe(context, 'touchstart', [{ x: 100, y: 200 }], context.__surfaceMarker)
    expect(context.loupeState).toBe('pending')
    expect(loupeDisplay(context)).toBeUndefined()
    expect(context.__timers).toHaveLength(1)
    expect(context.__timers[0].ms).toBe(150)
    firePendingTimer(context)
    expect(context.loupeState).toBe('visible')
    expect(loupeDisplay(context)).toBe('block')
    expect(context.__frames).toHaveLength(1)
  })

  it('never flashes on a quick tap', () => {
    const context = loadLoupe()
    fireLoupe(context, 'touchstart', [{ x: 100, y: 200 }], context.__surfaceMarker)
    fireLoupe(context, 'touchend', [], context.__surfaceMarker)
    expect(context.loupeState).toBe('idle')
    expect(loupeDisplay(context)).toBe('none')
    expect(context.__timers.every((t) => t.cleared)).toBe(true)
  })

  it('shows immediately when a selection handle is touched', () => {
    const context = loadLoupe()
    fireLoupe(context, 'touchstart', [{ x: 100, y: 200 }], context.__handleStartMarker)
    expect(context.loupeState).toBe('visible')
    expect(loupeDisplay(context)).toBe('block')
    expect(context.__timers).toHaveLength(0)
  })

  it('hides on touchcancel', () => {
    const context = loadLoupe()
    fireLoupe(context, 'touchstart', [{ x: 100, y: 200 }], context.__handleStartMarker)
    fireLoupe(context, 'touchcancel', [], null)
    expect(context.loupeState).toBe('idle')
    expect(loupeDisplay(context)).toBe('none')
  })

  it('hides immediately when a second finger lands (pinch)', () => {
    const context = loadLoupe()
    fireLoupe(context, 'touchstart', [{ x: 100, y: 200 }], context.__surfaceMarker)
    firePendingTimer(context)
    expect(context.loupeState).toBe('visible')
    fireLoupe(
      context,
      'touchstart',
      [
        { x: 100, y: 200 },
        { x: 200, y: 300 }
      ],
      context.__surfaceMarker
    )
    expect(context.loupeState).toBe('idle')
    expect(loupeDisplay(context)).toBe('none')
  })

  it('does not arm on touches outside the terminal surface', () => {
    const context = loadLoupe()
    fireLoupe(context, 'touchstart', [{ x: 100, y: 200 }], { marker: 'sel-menu' })
    expect(context.loupeState).toBe('idle')
    expect(context.__timers).toHaveLength(0)
  })

  it('tracks the finger while pending without showing', () => {
    const context = loadLoupe()
    fireLoupe(context, 'touchstart', [{ x: 100, y: 200 }], context.__surfaceMarker)
    fireLoupe(context, 'touchmove', [{ x: 140, y: 260 }], context.__surfaceMarker)
    expect(context.loupePoint).toEqual({ x: 140, y: 260 })
    expect(context.loupeState).toBe('pending')
    expect(loupeDisplay(context)).toBeUndefined()
  })
})

function probeCell(opts: { def: boolean; rgb: boolean; color: number }): LoupeCellProbe {
  return {
    isFgDefault: () => opts.def,
    isBgDefault: () => opts.def,
    isFgRGB: () => opts.rgb,
    isBgRGB: () => opts.rgb,
    isFgPalette: () => !opts.def && !opts.rgb,
    isBgPalette: () => !opts.def && !opts.rgb,
    getFgColor: () => opts.color,
    getBgColor: () => opts.color
  }
}
