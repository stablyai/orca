import { describe, expect, it } from 'vitest'
import { fitDimensionsFromCell } from './terminal-grid-fit'

// 23 device px at DPR 3: the WebGL renderer's 13px cell on the emulator.
const CELL_1X = { cellWidth: 23 / 3, cellHeight: 15 }

describe('fitDimensionsFromCell', () => {
  it('fits the frame React Native laid out', () => {
    // floor(427 / 7.667) = 55, floor(710 / 15) = 47
    expect(fitDimensionsFromCell(CELL_1X, 427, 710)).toEqual({ cols: 55, rows: 47 })
  })

  it('answers null for a frame too narrow to fit', () => {
    expect(fitDimensionsFromCell(CELL_1X, 100, 710)).toBeNull()
  })

  it('keeps an exact fit at a fractional pixel ratio whole', () => {
    // 900 device px of frame over 18 px cells at 2.75 is 50 columns; the two quotients divide
    // to 49.999… in floating point.
    const cell = { cellWidth: 18 / 2.75, cellHeight: 40 / 2.75 }
    expect(fitDimensionsFromCell(cell, 900 / 2.75, 1320 / 2.75)).toEqual({ cols: 50, rows: 33 })
  })

  it('still falls short of a column the frame does not hold', () => {
    const cell = { cellWidth: 393 / 51, cellHeight: 15 }
    expect(fitDimensionsFromCell(cell, 1080 / 2.75, 600)?.cols).toBe(50)
  })
})
