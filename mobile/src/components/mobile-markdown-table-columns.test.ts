import { describe, expect, it, vi } from 'vitest'
import { styles } from './mobile-markdown-styles'
import {
  MOBILE_MARKDOWN_TABLE_CELL_MAX_WIDTH,
  MOBILE_MARKDOWN_TABLE_CELL_MIN_WIDTH,
  mobileMarkdownGlyphColumns,
  mobileMarkdownTableColumnWidths
} from './mobile-markdown-table-columns'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles }
}))

describe('mobileMarkdownTableColumnWidths', () => {
  it('gives every row in a column the width of that column’s longest cell', () => {
    const widths = mobileMarkdownTableColumnWidths(['A', 'State'], [['x'.repeat(80), 'Open']])

    expect(widths).toHaveLength(2)
    expect(widths[0]).toBe(MOBILE_MARKDOWN_TABLE_CELL_MAX_WIDTH)
    expect(widths[1]).toBe(MOBILE_MARKDOWN_TABLE_CELL_MIN_WIDTH)
    expect(widths[0]).toBeGreaterThan(widths[1]!)
  })

  it('uses the header when it is wider than the body', () => {
    const widths = mobileMarkdownTableColumnWidths(['Repository name', 'S'], [['Orca', 'ok']])

    expect(widths[0]).toBeGreaterThan(MOBILE_MARKDOWN_TABLE_CELL_MIN_WIDTH)
    expect(widths[0]).toBeLessThan(MOBILE_MARKDOWN_TABLE_CELL_MAX_WIDTH)
    expect(widths[1]).toBe(MOBILE_MARKDOWN_TABLE_CELL_MIN_WIDTH)
  })

  it('does not let an empty cell collapse its column', () => {
    expect(mobileMarkdownTableColumnWidths(['', 'Notes'], [['', '']])).toEqual([
      MOBILE_MARKDOWN_TABLE_CELL_MIN_WIDTH,
      MOBILE_MARKDOWN_TABLE_CELL_MIN_WIDTH
    ])
  })

  it('measures the longest line of a wrapped cell', () => {
    const short = mobileMarkdownTableColumnWidths(['H'], [['short']])
    const wrapped = mobileMarkdownTableColumnWidths(['H'], [['short\nmuch longer line']])

    expect(wrapped[0]).toBeGreaterThan(short[0]!)
  })

  it('sizes a link from the label the cell paints, not the destination', () => {
    const linked = mobileMarkdownTableColumnWidths(
      ['H'],
      [[`[x](https://example.com/${'a'.repeat(80)})`]]
    )

    expect(linked).toEqual(mobileMarkdownTableColumnWidths(['H'], [['x']]))
    expect(linked[0]).toBe(MOBILE_MARKDOWN_TABLE_CELL_MIN_WIDTH)
  })

  it('still counts a bare URL that is shown in full', () => {
    const url = `https://example.com/${'a'.repeat(40)}`

    expect(mobileMarkdownTableColumnWidths(['H'], [[url]])[0]).toBe(
      MOBILE_MARKDOWN_TABLE_CELL_MAX_WIDTH
    )
  })

  it('ignores emphasis and code markers around visible text', () => {
    const text = 'n'.repeat(20)

    expect(mobileMarkdownTableColumnWidths(['H'], [[`**${text}**`]])).toEqual(
      mobileMarkdownTableColumnWidths(['H'], [[text]])
    )
    expect(mobileMarkdownTableColumnWidths(['H'], [[`\`${text}\``]])).toEqual(
      mobileMarkdownTableColumnWidths(['H'], [[text]])
    )
  })

  it('sizes wide glyphs wider than the same number of latin letters', () => {
    const hangul = '한'.repeat(20)
    const latin = 'a'.repeat(20)

    expect(mobileMarkdownTableColumnWidths(['H'], [[hangul]])[0]).toBe(
      MOBILE_MARKDOWN_TABLE_CELL_MAX_WIDTH
    )
    expect(mobileMarkdownTableColumnWidths(['H'], [[latin]])[0]).toBeLessThan(
      MOBILE_MARKDOWN_TABLE_CELL_MAX_WIDTH
    )
  })

  it('keeps a joined emoji at two columns when Intl.Segmenter is missing', () => {
    const family = '👨‍👩‍👧‍👦'.repeat(8)

    expect(mobileMarkdownGlyphColumns(family, null)).toBe(16)
  })

  it('counts a joined emoji once instead of once per UTF-16 unit', () => {
    const family = '👨‍👩‍👧‍👦'.repeat(8)
    const utf16Sized = 'a'.repeat(family.length)

    expect(mobileMarkdownTableColumnWidths(['H'], [[family]])[0]).toBeLessThan(
      mobileMarkdownTableColumnWidths(['H'], [[utf16Sized]])[0]!
    )
  })

  it('does not look through emphasis for a link destination', () => {
    const inner = '[x](https://ex.com/ab)'
    const wrapped = mobileMarkdownTableColumnWidths(['H'], [[`**${inner}**`]])

    expect(wrapped).toEqual(mobileMarkdownTableColumnWidths(['H'], [['n'.repeat(inner.length)]]))
    expect(wrapped[0]).toBeGreaterThan(mobileMarkdownTableColumnWidths(['H'], [[inner]])[0]!)
  })

  it('keeps intraword underscores in the measured text', () => {
    const snake = 'feature_branch_name'

    expect(mobileMarkdownTableColumnWidths(['H'], [[snake]])).toEqual(
      mobileMarkdownTableColumnWidths(['H'], [[snake.replaceAll('_', 'x')]])
    )
  })

  it('sizes an image from its alt text', () => {
    const alt = 'diagram'

    expect(
      mobileMarkdownTableColumnWidths(['H'], [[`![${alt}](https://example.com/${'a'.repeat(80)})`]])
    ).toEqual(mobileMarkdownTableColumnWidths(['H'], [[alt]]))
    expect(
      mobileMarkdownTableColumnWidths(['H'], [[`![](https://example.com/${'a'.repeat(80)})`]])
    ).toEqual(mobileMarkdownTableColumnWidths(['H'], [['image']]))
  })

  it('shares its clamp with the table cell style', () => {
    expect(styles.tableCell.minWidth).toBe(MOBILE_MARKDOWN_TABLE_CELL_MIN_WIDTH)
    expect(styles.tableCell.maxWidth).toBe(MOBILE_MARKDOWN_TABLE_CELL_MAX_WIDTH)
  })
})
