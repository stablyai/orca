import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'
import { styles } from './mobile-markdown-styles'

vi.mock('react-native', () => ({
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

/** Each rendered table row's cell styles, header row first. */
function renderTableCellStyles(content: string): unknown[][] {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(MobileMarkdown, { content }))
  })
  const rows = renderer!.root.findAll((node) => node.props.style === styles.tableRow)
  const cellStyles = rows.map((row) =>
    row.children.map((cell) => (typeof cell === 'string' ? undefined : cell.props.style))
  )
  act(() => renderer!.unmount())
  return cellStyles
}

function cellWidth(style: unknown): number {
  for (const entry of [style].flat()) {
    if (entry && typeof entry === 'object' && 'width' in entry && typeof entry.width === 'number') {
      return entry.width
    }
  }
  throw new Error('table cell has no width')
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [headers, headers.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n')
}

describe('MobileMarkdown tables', () => {
  it('renders every row and column with one width per column', () => {
    const headers = Array.from({ length: 10 }, (_, column) => `Column ${column}`)
    const rows = Array.from({ length: 50 }, (_, row) =>
      headers.map((_, column) => (row === 7 && column === 3 ? 'a much longer cell value' : 'x'))
    )
    const cellStyles = renderTableCellStyles(markdownTable(headers, rows))

    expect(cellStyles.map((row) => row.length)).toEqual(Array.from({ length: 51 }, () => 10))
    const widths = cellStyles.map((row) => row.map(cellWidth))
    for (const row of widths) {
      expect(row).toEqual(widths[0])
    }
    expect(widths[0]![3]).toBeGreaterThan(widths[0]![2]!)
  })

  it('sizes a column by the text it draws, not its markdown source', () => {
    const [widths] = renderTableCellStyles(
      markdownTable(
        ['A', 'B', 'C'],
        [['docs', '[docs](https://example.com/a/very/long/path)', '文档文档']]
      )
    ).map((row) => row.map(cellWidth))

    expect(widths![1]).toBe(widths![0])
    expect(widths![2]).toBeGreaterThan(widths![0]!)
  })
})
