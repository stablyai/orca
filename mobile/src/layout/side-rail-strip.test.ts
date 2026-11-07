import { describe, expect, it } from 'vitest'
import { getSideRailStrip, sideRailStripAboveKeyboard } from './side-rail-strip'

// Measured on the iPhone Duo simulator (iOS 27.1). The status column sits in the right inset.
const INNER_LANDSCAPE = {
  windowWidth: 951,
  windowHeight: 669,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [{ x: 867, y: 0, width: 84, height: 124 }]
}
const COVER_PORTRAIT = {
  windowWidth: 466,
  windowHeight: 678,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [
    { x: 399.67, y: 29.33, width: 37, height: 37 },
    { x: 382, y: 0, width: 84, height: 174 }
  ]
}

describe('getSideRailStrip', () => {
  it('offers the strip below the iPhone Duo status column, open or closed', () => {
    expect(getSideRailStrip(INNER_LANDSCAPE)).toEqual({
      side: 'right',
      width: 84,
      top: 124,
      bottom: 34,
      height: 511
    })
    expect(getSideRailStrip(COVER_PORTRAIT)).toEqual({
      side: 'right',
      width: 84,
      top: 174,
      bottom: 34,
      height: 470
    })
  })

  it('finds the strip on the left when the device is turned the other way', () => {
    expect(
      getSideRailStrip({
        ...INNER_LANDSCAPE,
        insets: { top: 0, right: 0, bottom: 34, left: 84 },
        occlusions: [{ x: 0, y: 545, width: 84, height: 124 }]
      })
    ).toEqual({ side: 'left', width: 84, top: 0, bottom: 124, height: 545 })
  })

  it('offers none where nothing occludes the side inset, as on a landscape iPhone', () => {
    expect(getSideRailStrip({ ...INNER_LANDSCAPE, occlusions: [] })).toBeNull()
    expect(
      getSideRailStrip({
        windowWidth: 852,
        windowHeight: 393,
        insets: { top: 0, right: 59, bottom: 21, left: 59 },
        occlusions: []
      })
    ).toBeNull()
  })

  it('offers none beside a camera island or anything that does not reach a screen edge', () => {
    expect(
      getSideRailStrip({
        windowWidth: 956,
        windowHeight: 440,
        insets: { top: 0, right: 62, bottom: 21, left: 62 },
        occlusions: [{ x: 11, y: 157, width: 37, height: 126 }]
      })
    ).toBeNull()
    expect(
      getSideRailStrip({
        ...INNER_LANDSCAPE,
        occlusions: [{ x: 867, y: 200, width: 84, height: 124 }]
      })
    ).toBeNull()
  })

  it('offers none when the inset is too narrow or the occlusion leaves too little below it', () => {
    expect(
      getSideRailStrip({ ...INNER_LANDSCAPE, insets: { ...INNER_LANDSCAPE.insets, right: 40 } })
    ).toBeNull()
    expect(
      getSideRailStrip({
        ...INNER_LANDSCAPE,
        occlusions: [{ x: 867, y: 0, width: 84, height: 520 }]
      })
    ).toBeNull()
  })

  it('ends the strip above the software keyboard, and offers none when it covers it all', () => {
    const strip = getSideRailStrip(INNER_LANDSCAPE)
    expect(sideRailStripAboveKeyboard(strip, 0)).toBe(strip)
    expect(sideRailStripAboveKeyboard(strip, 300)).toEqual({
      side: 'right',
      width: 84,
      top: 124,
      bottom: 300,
      height: 245
    })
    expect(sideRailStripAboveKeyboard(strip, 545)).toBeNull()
  })
})
