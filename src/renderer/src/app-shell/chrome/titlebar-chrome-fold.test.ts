import { describe, expect, it } from 'vitest'
import { decideTitlebarChromeFold, resolveTitlebarChromeFoldLevel } from './titlebar-chrome-fold'

function level(previous: 0 | 1 | 2, stripWidthAtLevel0: number, stripWidthAtLevel1: number) {
  return resolveTitlebarChromeFoldLevel({ previous, stripWidthAtLevel0, stripWidthAtLevel1 })
}

describe('resolveTitlebarChromeFoldLevel', () => {
  it('folds step 1 below 330px and unfolds only from 338px', () => {
    expect(level(0, 330, 400)).toBe(0)
    expect(level(0, 329, 400)).toBe(1)
    expect(level(1, 337, 400)).toBe(1)
    expect(level(1, 338, 400)).toBe(0)
  })

  it('folds step 2 below 190px and unfolds to step 1 only from 198px', () => {
    expect(level(1, 120, 190)).toBe(1)
    expect(level(1, 120, 189)).toBe(2)
    expect(level(2, 120, 197)).toBe(2)
    expect(level(2, 120, 198)).toBe(1)
  })

  it('starts unfolded inside the deadband', () => {
    expect(level(0, 334, 400)).toBe(0)
  })

  it('jumps straight back to full chrome from step 2 when the strip is wide again', () => {
    expect(level(2, 338, 420)).toBe(0)
  })
})

// A mac floating header: full 220px, 154px without the "Orca" word and Forward, 112px without Back.
const HEADER_BY_LEVEL = [220, 154, 112] as const

function settle(
  rowWidth: number,
  start: 0 | 1 | 2 = 0,
  cache: Partial<Record<0 | 1 | 2, number>> = {}
) {
  const levels: number[] = []
  let level = start
  for (let i = 0; i < 6; i++) {
    const header = HEADER_BY_LEVEL[level]
    cache[level] = header
    level = decideTitlebarChromeFold({
      previous: level,
      stripWidth: rowWidth - header,
      headerWidth: header,
      foldableWidthTo: (to) => header - HEADER_BY_LEVEL[to],
      cachedHeaderWidths: cache
    })
    levels.push(level)
  }
  return levels
}

describe('decideTitlebarChromeFold', () => {
  it('settles in one step and never flips while the pane width is stationary', () => {
    expect(settle(550)).toEqual([0, 0, 0, 0, 0, 0])
    expect(settle(549)).toEqual([1, 1, 1, 1, 1, 1])
    expect(settle(344)).toEqual([1, 1, 1, 1, 1, 1])
    expect(settle(343)).toEqual([2, 2, 2, 2, 2, 2])
    for (let row = 250; row <= 700; row++) {
      const levels = settle(row)
      expect(new Set(levels).size, `row ${row}`).toBe(1)
    }
  })

  it('unfolds from a measured level only past the hysteresis', () => {
    expect(settle(557, 1, { 0: 220 })).toEqual([1, 1, 1, 1, 1, 1])
    expect(settle(558, 1, { 0: 220 })).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('holds a folded level whose shallower width was never measured', () => {
    expect(settle(900, 1)).toEqual([1, 1, 1, 1, 1, 1])
    expect(settle(900, 2, { 0: 220 })).toEqual([0, 0, 0, 0, 0, 0])
  })
})
