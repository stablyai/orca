import { useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import type { Table } from 'mdast'
import type { MarkdownBlockContext } from './mobile-markdown-blocks'
import { mobileMarkdownTableColumnWidths } from './mobile-markdown-table-columns'
import { renderInline } from './mobile-markdown-inline'
import { MarkdownText } from './mobile-markdown-text'
import { MARKDOWN_TONES, styles } from './mobile-markdown-styles'
import { colors } from '../theme/mobile-theme'
import { plainText } from './mobile-markdown-tree'

/** One measured viewport and one column plan keep every row aligned, including wrapped cells. */
export function MobileMarkdownTable({ node, ctx }: { node: Table; ctx: MarkdownBlockContext }) {
  const [availableWidth, setAvailableWidth] = useState(0)
  const rows = node.children.map((row) => row.children)
  const textRows = useMemo(
    () => node.children.map((row) => row.children.map((cell) => plainText(cell))),
    [node]
  )
  const widths = mobileMarkdownTableColumnWidths(textRows, {
    availableWidth: Math.max(0, availableWidth - 2),
    textScale: ctx.textScale
  })
  const cellCtx = { ...ctx, tone: MARKDOWN_TONES.default }
  const headerCtx = {
    ...cellCtx,
    tone: { ...MARKDOWN_TONES.default, inlineCode: { backgroundColor: colors.bgBase } }
  }
  const contentWidth = widths.reduce((sum, width) => sum + width, 0)
  return (
    <View
      style={styles.table}
      onLayout={({ nativeEvent }) => {
        const width = nativeEvent.layout.width
        setAvailableWidth((previous) => (Math.abs(previous - width) > 0.5 ? width : previous))
      }}
    >
      <ScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator
        style={{ width: '100%' }}
        contentContainerStyle={{ width: contentWidth }}
      >
        <View style={{ width: contentWidth }}>
          {rows.map((cells, rowIndex) => (
            <View key={rowIndex} style={styles.tableRow}>
              {widths.map((width, cellIndex) => (
                <View
                  key={cellIndex}
                  style={[
                    styles.tableCell,
                    rowIndex === 0 ? styles.tableHeader : null,
                    {
                      width,
                      borderRightWidth: cellIndex === widths.length - 1 ? 0 : 1,
                      borderBottomWidth: rowIndex === rows.length - 1 ? 0 : 1
                    }
                  ]}
                >
                  <MarkdownText
                    selectable
                    style={[
                      styles.tableText,
                      rowIndex === 0 ? styles.bold : null,
                      {
                        textAlign: node.align?.[cellIndex] ?? 'left',
                        fontSize: 12 * ctx.textScale,
                        lineHeight: 18 * ctx.textScale
                      }
                    ]}
                  >
                    {renderInline(
                      cells[cellIndex]?.children ?? [],
                      rowIndex === 0 ? headerCtx : cellCtx,
                      [
                        styles.tableText,
                        { fontSize: 12 * ctx.textScale, lineHeight: 18 * ctx.textScale },
                        rowIndex === 0 ? styles.bold : null
                      ]
                    )}
                  </MarkdownText>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}
