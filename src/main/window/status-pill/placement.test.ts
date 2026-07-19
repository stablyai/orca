import { describe, expect, it } from 'vitest'
import type { Display } from 'electron'
import { computeStatusPillPlacement, hasMacNotch, pickDisplayForCursor } from './placement'

function makeDisplay(overrides: Partial<Display> = {}): Display {
  return {
    id: 1,
    label: 'Display',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    workAreaSize: { width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    internal: true,
    rotation: 0,
    scaleFactor: 1,
    touchSupport: 'unknown',
    monochrome: false,
    depthPerComponent: 8,
    colorDepth: 24,
    colorSpace: '{}',
    accelerometerSupport: 'unknown',
    incognito: false,
    isUnifiedDesk: false,
    maximumCursorSize: { width: 32, height: 32 },
    nativeOrigin: { x: 0, y: 0 },
    safeAreaInsets: { top: 0, left: 0, bottom: 0, right: 0 },
    ...overrides
  } as unknown as Display
}

describe('computeStatusPillPlacement', () => {
  it('centers horizontally on a plain top-center platform (linux)', () => {
    const display = makeDisplay()
    const placement = computeStatusPillPlacement({
      pillWidth: 320,
      pillHeight: 32,
      display,
      platform: 'linux'
    })
    expect(placement.x).toBe(Math.round((1920 - 320) / 2))
    expect(placement.y).toBe(8)
    expect(placement.width).toBe(320)
    expect(placement.height).toBe(32)
  })

  it('centers horizontally on Windows with an 8px top gap', () => {
    const display = makeDisplay()
    const placement = computeStatusPillPlacement({
      pillWidth: 320,
      pillHeight: 32,
      display,
      platform: 'win32'
    })
    expect(placement.x).toBe(Math.round((1920 - 320) / 2))
    expect(placement.y).toBe(8)
  })

  it('uses a notch-aware top offset on macOS when safeArea reports a notch', () => {
    // Why: safeArea.y >= 24 indicates a notch inset on modern Electron; the
    // pill should drop just below the notch work-area inset.
    const display = makeDisplay({
      workArea: { x: 0, y: 38, width: 1920, height: 1042 },
      safeAreaInsets: { top: 38, left: 0, bottom: 0, right: 0 }
    } as Partial<Display>)
    // Patch the safeArea getter shape used by hasMacNotch.
    ;(display as Display & { safeArea?: { y: number } }).safeArea = { y: 38 }
    const placement = computeStatusPillPlacement({
      pillWidth: 320,
      pillHeight: 32,
      display,
      platform: 'darwin'
    })
    expect(placement.y).toBe(38 + 6)
  })

  it('falls back to workArea.y heuristic when safeArea is not exposed', () => {
    const display = makeDisplay({
      workArea: { x: 0, y: 32, width: 1920, height: 1048 }
    })
    const placement = computeStatusPillPlacement({
      pillWidth: 320,
      pillHeight: 32,
      display,
      platform: 'darwin'
    })
    expect(placement.y).toBe(32 + 6)
  })

  it('uses no-notch offset on macOS when workArea.y is small', () => {
    const display = makeDisplay({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    })
    const placement = computeStatusPillPlacement({
      pillWidth: 320,
      pillHeight: 32,
      display,
      platform: 'darwin'
    })
    expect(placement.y).toBe(8)
  })

  it('honors a user-pinned X offset clamped within the work area', () => {
    const display = makeDisplay({
      workArea: { x: 100, y: 0, width: 1000, height: 800 }
    })
    const placement = computeStatusPillPlacement({
      pillWidth: 320,
      pillHeight: 32,
      display,
      platform: 'linux',
      pinnedXOffset: 200
    })
    expect(placement.x).toBe(200)
  })

  it('clamps an out-of-range pinned X offset back into the work area', () => {
    const display = makeDisplay({
      workArea: { x: 100, y: 0, width: 1000, height: 800 }
    })
    const placement = computeStatusPillPlacement({
      pillWidth: 320,
      pillHeight: 32,
      display,
      platform: 'linux',
      pinnedXOffset: 50000
    })
    expect(placement.x).toBe(100 + 1000 - 320 - 8)
  })

  it('falls back to NaN-safe minX when pinnedXOffset is not finite', () => {
    const display = makeDisplay({
      workArea: { x: 100, y: 0, width: 1000, height: 800 }
    })
    const placement = computeStatusPillPlacement({
      pillWidth: 320,
      pillHeight: 32,
      display,
      platform: 'linux',
      pinnedXOffset: Number.NaN
    })
    expect(placement.x).toBe(108)
  })
})

describe('hasMacNotch', () => {
  it('returns false on linux regardless of workArea inset', () => {
    const display = makeDisplay({
      workArea: { x: 0, y: 38, width: 1920, height: 1042 }
    })
    expect(hasMacNotch(display, 'linux')).toBe(false)
  })

  it('returns true on macOS when safeArea.y exceeds the heuristic', () => {
    const display = makeDisplay()
    ;(display as Display & { safeArea?: { y: number } }).safeArea = { y: 38 }
    expect(hasMacNotch(display, 'darwin')).toBe(true)
  })

  it('returns true on macOS via workArea.y heuristic when safeArea is missing', () => {
    const display = makeDisplay({
      workArea: { x: 0, y: 32, width: 1920, height: 1048 }
    })
    expect(hasMacNotch(display, 'darwin')).toBe(true)
  })
})

describe('pickDisplayForCursor', () => {
  it('returns null for an empty display list', () => {
    expect(pickDisplayForCursor([], null)).toBeNull()
  })

  it('returns the display containing the cursor when matched', () => {
    const primary = makeDisplay({ id: 1, internal: true })
    const external = makeDisplay({
      id: 2,
      internal: false,
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 }
    })
    expect(pickDisplayForCursor([primary, external], { x: 2500, y: 100 })).toBe(external)
  })

  it('falls back to the primary (internal) display when cursor is off-grid', () => {
    const primary = makeDisplay({ id: 1, internal: true })
    const external = makeDisplay({
      id: 2,
      internal: false,
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 }
    })
    expect(pickDisplayForCursor([primary, external], null)).toBe(primary)
  })

  it('falls back to the first display when none is internal', () => {
    const external = makeDisplay({
      id: 2,
      internal: false,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }
    })
    expect(pickDisplayForCursor([external], null)).toBe(external)
  })
})
