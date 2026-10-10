import { describe, expect, it } from 'vitest'
import { fitRow, imageNumbers, pngSize } from '../../examples/claude-image-view/hooks/layout'

describe('Orca image-view draft and layout boundaries', () => {
  it('accepts only positive safe numbered image markers, retaining draft order', () => {
    expect(
      imageNumbers('[Image #0] [Image #2] [Image #9007199254740992] [Image #1] [Image #2]')
    ).toEqual([2, 1])
  })

  it('never overflows narrow bands or draws into a band too short for a tile', () => {
    const sizes = [{ width: 100, height: 100 }, { width: 3000, height: 500 }, null, null]
    for (let width = 0; width < 140; width++) {
      for (let height = 0; height < 25; height++) {
        const row = fitRow(sizes, height, width)
        const occupiedWidth =
          row.reduce((sum, cell) => sum + cell.columns + 2, 0) + Math.max(0, row.length - 1)
        expect(occupiedWidth).toBeLessThanOrEqual(width)
        for (const cell of row) {
          expect(cell.rows + 3).toBeLessThanOrEqual(height)
        }
      }
    }
  })

  it('rejects a PNG signature without an IHDR chunk', () => {
    const bytes = new Uint8Array(24)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    new DataView(bytes.buffer).setUint32(16, 800)
    new DataView(bytes.buffer).setUint32(20, 600)
    expect(pngSize(btoa(String.fromCharCode(...bytes)))).toBeNull()
    expect(pngSize('invalid base64')).toBeNull()
  })

  it('waits for the PNG end chunk even when the dimensions are already readable', () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWPQ0PjwHwAD/AJA63QQFQAAAABJRU5ErkJggg=='
    expect(pngSize(png)).toEqual({ width: 1, height: 1 })
    expect(pngSize(png.slice(0, 48))).toBeNull()
    expect(pngSize(png.slice(0, 40) + '!'.repeat(24))).toBeNull()
  })
})
