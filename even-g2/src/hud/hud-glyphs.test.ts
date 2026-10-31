import { describe, expect, it } from 'vitest'
import {
  GLYPH_DISCONNECTED,
  GLYPH_DONE,
  GLYPH_IDLE,
  GLYPH_NEEDS_INPUT,
  GLYPH_WORKING,
  middleEllipsize
} from './hud-glyphs'

describe('glyph constants', () => {
  it('exposes the verified ASCII/narrow glyph set', () => {
    expect(GLYPH_WORKING).toBe('▶')
    expect(GLYPH_NEEDS_INPUT).toBe('▲')
    expect(GLYPH_DONE).toBe('●')
    expect(GLYPH_IDLE).toBe('○')
    expect(GLYPH_DISCONNECTED).toBe('◇')
  })
})

describe('middleEllipsize', () => {
  it('returns the name unchanged when it already fits', () => {
    expect(middleEllipsize('api', 20)).toBe('api')
    expect(middleEllipsize('exactly-twenty-chrs', 20)).toBe('exactly-twenty-chrs')
  })

  it('cuts the middle, keeping head and tail, when the name overflows', () => {
    const result = middleEllipsize('a-very-long-worktree-name-indeed', 20)
    expect(result).toHaveLength(20)
    expect(result).toContain('…')
    expect(result.startsWith('a-very-l')).toBe(true)
    expect(result.endsWith('indeed')).toBe(true)
  })

  it('degrades to a plain head slice when max is too small for an ellipsis', () => {
    expect(middleEllipsize('worktree', 1)).toBe('w')
    expect(middleEllipsize('worktree', 0)).toBe('')
  })

  it('HIGH #5: keeps two names sharing a 19-char prefix distinguishable after ellipsizing', () => {
    const prefix = 'x'.repeat(19)
    const nameA = `${prefix}AAAAAA`
    const nameB = `${prefix}BBBBBB`
    const a = middleEllipsize(nameA, 20)
    const b = middleEllipsize(nameB, 20)
    expect(a).not.toBe(b)
    expect(a).toContain('AAAAAA')
    expect(b).toContain('BBBBBB')
  })
})
