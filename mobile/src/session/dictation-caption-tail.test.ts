import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAPTION_CHAR_BUDGET,
  captionCharBudget,
  captionStripMinHeight,
  captionTail
} from './dictation-caption-tail'

describe('captionTail', () => {
  it('keeps a caption that fits untouched', () => {
    expect(captionTail('git status', 40)).toBe('git status')
  })

  it('keeps the newest words and starts on a word boundary', () => {
    const caption = 'one two three four five six seven eight nine ten'
    expect(captionTail(caption, 20)).toBe('…eight nine ten')
  })

  it('cuts inside a very long word instead of dropping it', () => {
    const tail = captionTail(`start ${'x'.repeat(50)}`, 20)
    expect(tail).toBe(`…${'x'.repeat(19)}`)
  })
})

describe('captionTail with wide glyphs', () => {
  it('counts CJK glyphs as wide so 100 of them still fit two lines', () => {
    const budget = captionCharBudget(336, 14, 1)
    const caption = '你好世界'.repeat(25)
    const tail = captionTail(caption, budget)
    expect(tail.startsWith('…')).toBe(true)
    // Why: each CJK glyph is two units, plus one for the ellipsis.
    expect(Array.from(tail).length).toBeLessThanOrEqual(Math.floor((budget - 1) / 2) + 1)
    expect(caption.endsWith(tail.slice(1))).toBe(true)
  })

  it('keeps a whole emoji instead of splitting its surrogate pair', () => {
    const tail = captionTail('😀'.repeat(30), 10)
    expect(Array.from(tail.slice(1)).every((glyph) => glyph === '😀')).toBe(true)
  })
})

describe('captionStripMinHeight', () => {
  it('grows with Dynamic Type up to the caption cap', () => {
    expect(captionStripMinHeight(1)).toBe(54)
    expect(captionStripMinHeight(1.3)).toBeGreaterThan(captionStripMinHeight(1))
    expect(captionStripMinHeight(3)).toBe(captionStripMinHeight(1.5))
  })
})

describe('captionCharBudget', () => {
  it('fits two lines of the measured width', () => {
    expect(captionCharBudget(336, 14, 1)).toBe(80)
  })

  it('shrinks with Dynamic Type', () => {
    expect(captionCharBudget(336, 14, 2)).toBeLessThan(captionCharBudget(336, 14, 1))
  })

  it('falls back before the first layout', () => {
    expect(captionCharBudget(0, 14, 1)).toBe(DEFAULT_CAPTION_CHAR_BUDGET)
  })
})
