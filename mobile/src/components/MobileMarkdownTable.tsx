import type { ComponentType, ReactNode } from 'react'
import { ScrollView, Text as NativeText, View, type TextProps } from 'react-native'
import { mobileMarkdownTableColumnWidths } from './mobile-markdown-table-columns'
import { styles } from './mobile-markdown-styles'

const MAX_TABLE_ROWS = 40
const MAX_TABLE_COLUMNS = 8

type Props = {
  headers: readonly string[]
  rows: readonly (readonly string[])[]
  renderCell: (text: string) => ReactNode
  TextComponent: ComponentType<TextProps>
}

export function MobileMarkdownTable({ headers, rows, renderCell, TextComponent }: Props) {
  const visibleHeaders = headers.slice(0, MAX_TABLE_COLUMNS)
  const visibleRows = rows.slice(0, MAX_TABLE_ROWS)
  const columnWidths = mobileMarkdownTableColumnWidths(visibleHeaders, visibleRows)
  const hiddenRows = Math.max(0, rows.length - visibleRows.length)
  const hiddenColumns = Math.max(0, headers.length - visibleHeaders.length)

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.table}>
        <View style={styles.tableRow}>
          {visibleHeaders.map((header, cellIndex) => (
            <TextComponent
              key={cellIndex}
              selectable
              style={[styles.tableCell, styles.tableHeader, { width: columnWidths[cellIndex] }]}
            >
              {renderCell(header)}
            </TextComponent>
          ))}
        </View>
        {visibleRows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.tableRow}>
            {visibleHeaders.map((_, cellIndex) => (
              <TextComponent
                key={cellIndex}
                selectable
                style={[styles.tableCell, { width: columnWidths[cellIndex] }]}
              >
                {renderCell(row[cellIndex] ?? '')}
              </TextComponent>
            ))}
          </View>
        ))}
        {hiddenRows > 0 || hiddenColumns > 0 ? (
          <NativeText style={styles.tableTruncated}>
            {hiddenRows > 0 ? `${hiddenRows} more rows` : ''}
            {hiddenRows > 0 && hiddenColumns > 0 ? ' · ' : ''}
            {hiddenColumns > 0 ? `${hiddenColumns} more columns` : ''}
          </NativeText>
        ) : null}
      </View>
    </ScrollView>
  )
}
