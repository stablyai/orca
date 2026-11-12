import { describe, expect, it } from 'vitest'
import { fitDimensionsFromCell } from './terminal-grid-fit'

describe('fitDimensionsFromCell', () => {
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
