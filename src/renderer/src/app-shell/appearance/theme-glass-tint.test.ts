import { describe, expect, it } from 'vitest'
import type { Rgba } from '../../../../shared/color/rgba-contrast'
import { readableGlassTint } from './theme-glass-tint'

const BLACK: Rgba = [0, 0, 0, 1]
const WHITE: Rgba = [255, 255, 255, 1]

describe('readableGlassTint', () => {
  it('keeps the requested tint when the text already reads over the image', () => {
    expect(readableGlassTint(0.5, [BLACK], [{ surface: BLACK, texts: [WHITE] }])).toBe(0.5)
  })

  it('raises the tint until white text on black chrome reads 4.5:1 over a white image', () => {
    // A 0.5 veil leaves gray 128 (3.9:1); 0.55 leaves gray 115 (4.8:1).
    expect(readableGlassTint(0.5, [WHITE], [{ surface: BLACK, texts: [WHITE] }])).toBeCloseTo(0.55)
  })
})
