import { describe, expect, it } from 'vitest'
import { paginateHudBody } from './hud-text-pagination'

describe('paginateHudBody', () => {
  it('passes through as a single page when content fits', () => {
    const pages = paginateHudBody(['line 1', 'line 2', 'line 3'])
    expect(pages).toEqual(['line 1\nline 2\nline 3'])
  })

  it('splits at line boundaries once the 9-line cap is exceeded', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`)
    const pages = paginateHudBody(lines)
    expect(pages).toHaveLength(2)
    expect(pages[0]?.split('\n')).toHaveLength(9)
    expect(pages[1]?.split('\n')).toHaveLength(1)
  })

  it('splits once the char cap is exceeded, even under the line cap', () => {
    const lines = ['a'.repeat(250), 'b'.repeat(250)]
    const pages = paginateHudBody(lines, { maxCharsPerPage: 400 })
    expect(pages).toHaveLength(2)
    expect(pages[0]).toBe('a'.repeat(250))
    expect(pages[1]).toBe('b'.repeat(250))
  })

  it('never splits mid-line: an over-length single line still gets its own page', () => {
    const longLine = 'x'.repeat(500)
    const pages = paginateHudBody([longLine, 'short'], { maxCharsPerPage: 400 })
    expect(pages[0]).toBe(longLine)
    expect(pages[1]).toBe('short')
  })

  it('never leaves a trailing newline on the last line of a page', () => {
    const pages = paginateHudBody(['a', 'b'])
    expect(pages[0]?.endsWith('\n')).toBe(false)
  })

  it('respects a custom maxLinesPerPage', () => {
    const lines = ['1', '2', '3', '4', '5']
    const pages = paginateHudBody(lines, { maxLinesPerPage: 2 })
    expect(pages).toEqual(['1\n2', '3\n4', '5'])
  })

  it('returns a single empty page for empty input', () => {
    expect(paginateHudBody([])).toEqual([''])
  })

  // Finding #19: a page's real on-glass footprint depends on visual rows, not just explicit
  // newlines — a long line must be wrapped and counted as multiple rows before pagination.
  it('wraps wide lines to maxGlyphsPerLine and counts each wrapped row toward the page budget', () => {
    const wideLine = 'x'.repeat(150) // 3 rows at 50 glyphs/row
    const pages = paginateHudBody([wideLine, 'short'], { maxGlyphsPerLine: 50, maxLinesPerPage: 3 })
    expect(pages).toEqual([Array(3).fill('x'.repeat(50)).join('\n'), 'short'])
  })

  it('never emits an oversized first page: a 1,200-char single-line body paginates to multiple pages when wrapped', () => {
    const body = 'y'.repeat(1200)
    const pages = paginateHudBody([body], { maxGlyphsPerLine: 60, maxLinesPerPage: 9 })
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      const rows = page.split('\n')
      expect(rows.length).toBeLessThanOrEqual(9)
      for (const row of rows) {
        expect(row.length).toBeLessThanOrEqual(60)
      }
    }
  })

  it('reservedLines shrinks the per-page line budget so caller controls still fit', () => {
    const lines = ['1', '2', '3', '4', '5']
    const pages = paginateHudBody(lines, { maxLinesPerPage: 5, reservedLines: 3 })
    expect(pages).toEqual(['1\n2', '3\n4', '5'])
  })
})
