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
})
