import { describe, expect, it } from 'vitest'
import { mobileMarkdownTableColumnWidths } from './mobile-markdown-table-columns'

describe('responsive markdown column layout', () => {
  const rows = [
    ['Name', 'Description'],
    ['A', 'A longer description with several words']
  ]
  it('fills the measured viewport even for a short table', () => {
    const widths = mobileMarkdownTableColumnWidths([['A', 'B']], { availableWidth: 360 })
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(360)
  })
  it('scrolls when content-sized columns exceed the viewport', () => {
    const widths = mobileMarkdownTableColumnWidths(rows, { availableWidth: 260 })
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeGreaterThan(260)
    expect(widths[1]).toBeGreaterThan(widths[0]!)
  })
  it('keeps wide tables horizontally scrollable instead of crushing the text', () => {
    const widths = mobileMarkdownTableColumnWidths([Array.from({ length: 8 }, () => 'Column')], {
      availableWidth: 320
    })
    expect(widths.every((width) => width >= 72)).toBe(true)
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeGreaterThan(320)
  })
  it.each([1, 1.5])(
    'keeps content-sized columns for an overflowing table at scale %s',
    (textScale) => {
      const widths = mobileMarkdownTableColumnWidths(
        [Array.from({ length: 5 }, () => 'x'.repeat(100))],
        {
          availableWidth: 320,
          textScale
        }
      )
      expect(widths).toEqual(Array(5).fill(220 * textScale))
    }
  )
  it('accounts for text size, CJK, long identifiers and rotation', () => {
    const table = [
      ['A', '文档文档'],
      ['x', 'a'.repeat(1000)]
    ]
    const normal = mobileMarkdownTableColumnWidths(table)
    const large = mobileMarkdownTableColumnWidths(table, { textScale: 1.5 })
    expect(large[0]).toBeGreaterThan(normal[0]!)
    expect(large[1]).toBe(330)
    expect(
      mobileMarkdownTableColumnWidths(rows, { availableWidth: 640 }).reduce((a, b) => a + b, 0)
    ).toBeCloseTo(640)
    expect(mobileMarkdownTableColumnWidths([])).toEqual([])
  })
})
