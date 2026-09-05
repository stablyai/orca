import { describe, expect, it } from 'vitest'
import {
  GLYPH_DISCONNECTED,
  GLYPH_DONE,
  GLYPH_IDLE,
  GLYPH_NEEDS_INPUT,
  GLYPH_WORKING,
  toFullwidthColumns
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

describe('toFullwidthColumns', () => {
  it('pads each column to its fixed width with ideographic spaces', () => {
    const rows = toFullwidthColumns([[GLYPH_WORKING, 'api', '12m']], [2, 10, 5])
    const row = rows[0]!
    // Column boundaries land at the code-unit offsets given by widths.
    expect(row.slice(0, 2)).toBe(`${GLYPH_WORKING}　`)
    expect(row.slice(2, 12)).toBe(`api${'　'.repeat(7)}`)
    expect(row.slice(12, 17)).toBe(`12m${'　'.repeat(2)}`)
  })

  it('produces equal code-unit width per row regardless of glyph/name length', () => {
    const rows = toFullwidthColumns(
      [
        [GLYPH_WORKING, 'a', '1m'],
        [GLYPH_IDLE, 'much-longer-name', '120m']
      ],
      [2, 8, 6]
    )
    const widths = rows.map((r) => r.length)
    expect(widths[0]).toBe(widths[1])
    expect(widths[0]).toBe(2 + 8 + 6)
  })

  it('truncates a cell that overflows its column width with an ellipsis', () => {
    const rows = toFullwidthColumns([['a-very-long-worktree-name']], [8])
    expect(rows[0]).toBe('a-very-…')
    expect(rows[0]).toHaveLength(8)
  })

  it('falls back to the cell length when no width is given for a column', () => {
    const rows = toFullwidthColumns([['abc', 'extra']], [10])
    expect(rows[0]).toBe(`abc${'　'.repeat(7)}extra`)
  })
})
