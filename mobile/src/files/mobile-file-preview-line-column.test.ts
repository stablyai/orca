import { describe, expect, it } from 'vitest'
import {
  estimateScrollOffsetForLine,
  normalizeMobileFilePreviewLineColumn,
  scrollOffsetForPreviewLine,
  textOffsetForLineColumn
} from './mobile-file-preview-line-column'

describe('mobile-file-preview-line-column', () => {
  it('normalizes positive route params and rejects invalid lines', () => {
    expect(normalizeMobileFilePreviewLineColumn('12', '3')).toEqual({ line: 12, column: 3 })
    expect(normalizeMobileFilePreviewLineColumn('12', undefined)).toEqual({
      line: 12,
      column: null
    })
    expect(normalizeMobileFilePreviewLineColumn('0', '3')).toBeNull()
    expect(normalizeMobileFilePreviewLineColumn('12x', '3')).toBeNull()
    expect(normalizeMobileFilePreviewLineColumn(undefined, '3')).toBeNull()
  })

  it('converts one-based line and column values to a text offset', () => {
    const content = 'alpha\nbravo\ncharlie'

    expect(textOffsetForLineColumn(content, { line: 1, column: 1 })).toBe(0)
    expect(textOffsetForLineColumn(content, { line: 2, column: 3 })).toBe(8)
    expect(textOffsetForLineColumn(content, { line: 3, column: null })).toBe(12)
  })

  it('caps out-of-range line and column values safely', () => {
    const content = 'alpha\nbravo'

    expect(textOffsetForLineColumn(content, { line: 99, column: 1 })).toBe(content.length)
    expect(textOffsetForLineColumn(content, { line: 1, column: 99 })).toBe(5)
  })

  it('maps line numbers to the mono preview scroll offset', () => {
    expect(scrollOffsetForPreviewLine(1)).toBe(0)
    expect(scrollOffsetForPreviewLine(4)).toBe(57)
  })

  it('estimates scroll offset accounting for wrapped lines', () => {
    expect(estimateScrollOffsetForLine(null, 4)).toBe(57)
    expect(estimateScrollOffsetForLine([], 1)).toBe(0)

    // Unwrapped lines match scrollOffsetForPreviewLine
    const unwrapped = ['const a = 1', 'const b = 2', 'const c = 3', 'const d = 4']
    expect(estimateScrollOffsetForLine(unwrapped, 4, 40)).toBe(57)

    // Long lines wrap and add extra height
    const wrapped = [
      'a'.repeat(80), // 2 visual lines
      'b'.repeat(20), // 1 visual line
      'c'.repeat(120), // 3 visual lines
      'target'
    ]
    // Lines 1..3 take 2 + 1 + 3 = 6 visual lines = 6 * 19 = 114px
    expect(estimateScrollOffsetForLine(wrapped, 4, 40)).toBe(114)
  })
})
