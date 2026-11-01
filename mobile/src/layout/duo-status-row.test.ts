import { describe, expect, it } from 'vitest'
import { spacing } from '../theme/mobile-theme'
import {
  DUO_RAIL_CONTROL_SIZE,
  DUO_STATUS_GLYPH_FROM_EDGE,
  DUO_STATUS_GLYPH_SIZE,
  duoRailBackFrame
} from './duo-status-row'
import { getSideRailStrip } from './side-rail-strip'

const INNER = {
  windowWidth: 951,
  windowHeight: 669,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [{ x: 867, y: 0, width: 84, height: 124 }]
}
const COVER = {
  windowWidth: 466,
  windowHeight: 678,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [
    { x: 399.67, y: 29.33, width: 37, height: 37 },
    { x: 382, y: 0, width: 84, height: 174 }
  ]
}
const ROW_CENTER = DUO_STATUS_GLYPH_FROM_EDGE + DUO_STATUS_GLYPH_SIZE / 2

function overlaps(
  frame: { top: number; left: number; size: number | null },
  region: { x: number; y: number; width: number; height: number }
): boolean {
  const size = frame.size ?? 0
  return (
    frame.left < region.x + region.width &&
    frame.left + size > region.x &&
    frame.top < region.y + region.height &&
    frame.top + size > region.y
  )
}

describe('the Duo status row', () => {
  it('places the inner control below the status occlusion, on the cluster midX', () => {
    const strip = getSideRailStrip(INNER)
    const column = INNER.occlusions[0]!
    const midX = INNER.windowWidth - ROW_CENTER
    expect(strip).not.toBeNull()
    const frame = duoRailBackFrame({ ...INNER, strip: strip! })
    expect(frame).toEqual({
      top: column.y + column.height + spacing.sm,
      left: midX - DUO_RAIL_CONTROL_SIZE / 2,
      size: DUO_RAIL_CONTROL_SIZE
    })
    expect(frame.left + frame.size / 2).toBe(midX)
    expect(frame.left).toBeGreaterThanOrEqual(column.x)
    expect(frame.left + frame.size).toBeLessThanOrEqual(column.x + column.width)
    expect(overlaps(frame, column)).toBe(false)
  })

  it('places the cover control below the status column and clears a bottom column upward', () => {
    const cover = getSideRailStrip(COVER)
    const glyph = COVER.occlusions[0]!
    const column = COVER.occlusions[1]!
    const midX = glyph.x + glyph.width / 2
    const frame = duoRailBackFrame({ ...COVER, strip: cover! })
    expect(frame).toEqual({
      top: column.y + column.height + spacing.sm,
      left: midX - DUO_RAIL_CONTROL_SIZE / 2,
      size: DUO_RAIL_CONTROL_SIZE
    })
    expect(frame.left + frame.size / 2).toBe(midX)
    expect(frame.left).toBeGreaterThanOrEqual(column.x)
    expect(frame.left + frame.size).toBeLessThanOrEqual(column.x + column.width)
    expect(overlaps(frame, column)).toBe(false)
    expect(overlaps(frame, glyph)).toBe(false)

    const occlusion = { x: 0, y: 545, width: 84, height: 124 }
    const turned = {
      windowWidth: 951,
      windowHeight: 669,
      strip: getSideRailStrip({
        windowWidth: 951,
        windowHeight: 669,
        insets: { top: 0, right: 0, bottom: 34, left: 84 },
        occlusions: [occlusion]
      })!
    }
    const turnedFrame = duoRailBackFrame({ ...turned, occlusions: [occlusion] })
    expect(turnedFrame.top).toBe(occlusion.y - spacing.sm - DUO_RAIL_CONTROL_SIZE)
    expect(turnedFrame.left).toBe(ROW_CENTER - DUO_RAIL_CONTROL_SIZE / 2)
    expect(turnedFrame.left).toBeGreaterThanOrEqual(occlusion.x)
    expect(turnedFrame.left + turnedFrame.size).toBeLessThanOrEqual(occlusion.x + occlusion.width)
    expect(overlaps(turnedFrame, occlusion)).toBe(false)
  })

  it('clears a status column that touches the bottom edge', () => {
    const glyph = { x: 29.33, y: 678 - 29.33 - 37, width: 37, height: 37 }
    const column = { x: 0, y: 678 - 174, width: 84, height: 174 }
    const scene = {
      windowWidth: 466,
      windowHeight: 678,
      insets: { top: 0, right: 0, bottom: 34, left: 84 },
      occlusions: [glyph, column]
    }
    const frame = duoRailBackFrame({ ...scene, strip: getSideRailStrip(scene)! })
    expect(frame.top).toBe(column.y - spacing.sm - DUO_RAIL_CONTROL_SIZE)
    expect(frame.left).toBe(glyph.x + glyph.width / 2 - DUO_RAIL_CONTROL_SIZE / 2)
    expect(frame.left + frame.size / 2).toBe(glyph.x + glyph.width / 2)
    expect(frame.left).toBeGreaterThanOrEqual(column.x)
    expect(frame.left + frame.size).toBeLessThanOrEqual(column.x + column.width)
    expect(overlaps(frame, column)).toBe(false)
    expect(overlaps(frame, glyph)).toBe(false)
  })

  it('uses the strip edge when no status occlusion rect is reported', () => {
    const frame = duoRailBackFrame({
      windowWidth: 951,
      windowHeight: 669,
      strip: { side: 'right', width: 84, top: 59, bottom: 34, height: 576 },
      occlusions: []
    })
    expect(frame.top).toBe(59 + spacing.sm)
    expect(frame.left).toBe(951 - ROW_CENTER - DUO_RAIL_CONTROL_SIZE / 2)
  })

  it('keeps the control inside the column when the cluster sits near the screen edge', () => {
    const glyph = { x: 430, y: 29.33, width: 30, height: 37 }
    const column = { x: 382, y: 0, width: 84, height: 174 }
    const scene = {
      windowWidth: 466,
      windowHeight: 678,
      insets: { top: 0, right: 84, bottom: 34, left: 0 },
      occlusions: [glyph, column]
    }
    const frame = duoRailBackFrame({ ...scene, strip: getSideRailStrip(scene)! })
    expect(frame.left).toBe(column.x + column.width - DUO_RAIL_CONTROL_SIZE)
    expect(frame.left).toBeGreaterThanOrEqual(column.x)
    expect(frame.left + frame.size).toBeLessThanOrEqual(column.x + column.width)
  })
})
