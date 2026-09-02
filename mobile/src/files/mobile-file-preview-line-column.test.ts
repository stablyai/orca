import { describe, expect, it } from 'vitest'
import {
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
})
