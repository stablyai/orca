import { describe, expect, it } from 'vitest'
import { fitDimensionsFromCell } from './terminal-grid-fit'

const CELL_1X = { cellWidth: 23 / 3, cellHeight: 15 }

describe('fitDimensionsFromCell', () => {
  it('fits the frame React Native laid out', () => {
    expect(fitDimensionsFromCell(CELL_1X, 427, 710)).toEqual({ cols: 55, rows: 47 })
  })

  it('answers null for a frame too narrow to fit', () => {
    expect(fitDimensionsFromCell(CELL_1X, 100, 710)).toBeNull()
  })

  it('keeps an exact fit at a fractional pixel ratio whole', () => {
    // An exact device-pixel fit can divide to 49.999… after pixel-ratio conversion.
    const cell = { cellWidth: 18 / 2.75, cellHeight: 40 / 2.75 }
    expect(fitDimensionsFromCell(cell, 900 / 2.75, 1320 / 2.75)).toEqual({ cols: 50, rows: 33 })
  })

  it('still falls short of a column the frame does not hold', () => {
    const cell = { cellWidth: 393 / 51, cellHeight: 15 }
    expect(fitDimensionsFromCell(cell, 1080 / 2.75, 600)?.cols).toBe(50)
  })
})
