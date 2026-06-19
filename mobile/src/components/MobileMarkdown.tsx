import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { parseMobileMarkdown } from './mobile-markdown-parser'

type Props = {
  content?: string
  fallback?: string
}

const MAX_TABLE_ROWS = 40
const MAX_TABLE_COLUMNS = 8

function openMarkdownUrl(url: string): void {
  const trimmed = url.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) {
    void Linking.openURL(trimmed)
  }
}

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const pattern =
    /(!\[[^\]]*\]\([^)]+\)|`[^`]+`|~~[^~]+~~|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<]+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    const key = `${match.index}:${token}`
    const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (image) {
      parts.push(
        <Text key={key} style={styles.link} onPress={() => openMarkdownUrl(image[2]!)}>
          {image[1] || 'image'}
        </Text>
      )
    } else if (link) {
      parts.push(
        <Text key={key} style={styles.link} onPress={() => openMarkdownUrl(link[2]!)}>
          {link[1]}
        </Text>
      )
    } else if (/^https?:\/\//i.test(token)) {
      parts.push(
        <Text key={key} style={styles.link} onPress={() => openMarkdownUrl(token)}>
          {token}
        </Text>
      )
    } else if (token.startsWith('`')) {
      parts.push(
        <Text key={key} style={styles.inlineCode}>
          {token.slice(1, -1)}
        </Text>
      )
    } else if (token.startsWith('~~')) {
      parts.push(
        <Text key={key} style={styles.strike}>
          {token.slice(2, -2)}
        </Text>
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      parts.push(
        <Text key={key} style={styles.bold}>
          {token.slice(2, -2)}
        </Text>
      )
    } else {
      parts.push(
        <Text key={key} style={styles.italic}>
          {token.slice(1, -1)}
        </Text>
      )
    }
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts
}

function MobileMarkdownInner({ content, fallback = '' }: Props) {
  const text = content?.trim() ?? ''
  const blocks = useMemo(() => parseMobileMarkdown(text), [text])
  if (!text) {
    return fallback ? <Text style={styles.paragraph}>{fallback}</Text> : null
  }

  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          return (
            <Text
              key={index}
              style={[styles.heading, block.level <= 2 ? styles.headingLarge : null]}
            >
              {renderInline(block.text)}
            </Text>
          )
        }
        if (block.type === 'quote') {
          return (
            <View key={index} style={styles.quote}>
              <Text style={styles.quoteText}>{renderInline(block.text)}</Text>
            </View>
          )
        }
        if (block.type === 'code') {
          return (
            <View key={index} style={styles.codeBlock}>
              {block.language ? <Text style={styles.codeLanguage}>{block.language}</Text> : null}
              <Text style={styles.codeText}>{block.text}</Text>
            </View>
          )
        }
        if (block.type === 'image') {
          return (
            <Pressable
              key={index}
              style={styles.imageFrame}
              onPress={() => openMarkdownUrl(block.url)}
            >
              <Text style={styles.link}>{block.alt || 'Open image'}</Text>
              <Text style={styles.imageCaption} numberOfLines={1}>
                {block.url}
              </Text>
            </Pressable>
          )
        }
        if (block.type === 'table') {
          const visibleHeaders = block.headers.slice(0, MAX_TABLE_COLUMNS)
          const visibleRows = block.rows.slice(0, MAX_TABLE_ROWS)
          const hiddenRows = Math.max(0, block.rows.length - visibleRows.length)
          const hiddenColumns = Math.max(0, block.headers.length - visibleHeaders.length)
          return (
            <ScrollView key={index} horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.table}>
                <View style={styles.tableRow}>
                  {visibleHeaders.map((header, cellIndex) => (
                    <Text key={cellIndex} style={[styles.tableCell, styles.tableHeader]}>
                      {renderInline(header)}
                    </Text>
                  ))}
                </View>
                {visibleRows.map((row, rowIndex) => (
                  <View key={rowIndex} style={styles.tableRow}>
                    {visibleHeaders.map((_, cellIndex) => (
                      <Text key={cellIndex} style={styles.tableCell}>
                        {renderInline(row[cellIndex] ?? '')}
                      </Text>
                    ))}
                  </View>
                ))}
                {hiddenRows > 0 || hiddenColumns > 0 ? (
                  <Text style={styles.tableTruncated}>
                    {hiddenRows > 0 ? `${hiddenRows} more rows` : ''}
                    {hiddenRows > 0 && hiddenColumns > 0 ? ' · ' : ''}
                    {hiddenColumns > 0 ? `${hiddenColumns} more columns` : ''}
                  </Text>
                ) : null}
              </View>
            </ScrollView>
          )
        }
        if (block.type === 'list') {
          return (
            <View key={index} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.listItem}>
                  <Text style={styles.listMarker}>
                    {item.checked == null
                      ? block.ordered
                        ? `${itemIndex + 1}.`
                        : '-'
                      : item.checked
                        ? '[x]'
                        : '[ ]'}
                  </Text>
                  <Text style={styles.listText}>{renderInline(item.text)}</Text>
                </View>
              ))}
            </View>
          )
        }
        if (block.type === 'rule') {
          return <View key={index} style={styles.rule} />
        }
        return (
          <Text key={index} style={styles.paragraph}>
            {block.text.split('\n').map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 ? '\n' : null}
                {renderInline(line)}
              </Fragment>
            ))}
          </Text>
        )
      })}
    </View>
  )
}

export const MobileMarkdown = memo(MobileMarkdownInner)

const styles = StyleSheet.create({
  root: {
    gap: spacing.sm
  },
  paragraph: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  },
  heading: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  headingLarge: {
    fontSize: 15,
    lineHeight: 21
  },
  bold: {
    fontWeight: '700',
    color: colors.textPrimary
  },
  italic: {
    fontStyle: 'italic'
  },
  strike: {
    textDecorationLine: 'line-through'
  },
  link: {
    color: colors.accentBlue,
    textDecorationLine: 'underline'
  },
  inlineCode: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.row,
    paddingHorizontal: 4
  },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    paddingLeft: spacing.sm
  },
  quoteText: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary
  },
  codeBlock: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    padding: spacing.sm
  },
  codeLanguage: {
    fontSize: 10,
    color: colors.textMuted,
    marginBottom: spacing.xs,
    textTransform: 'uppercase'
  },
  codeText: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textPrimary
  },
  imageFrame: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    backgroundColor: colors.bgRaised,
    overflow: 'hidden',
    padding: spacing.sm
  },
  imageCaption: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    fontSize: 11,
    color: colors.textSecondary
  },
  table: {
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    overflow: 'hidden',
    backgroundColor: colors.bgPanel
  },
  tableRow: {
    flexDirection: 'row'
  },
  tableCell: {
    minWidth: 112,
    maxWidth: 220,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textPrimary
  },
  tableHeader: {
    fontWeight: '700',
    backgroundColor: colors.bgRaised
  },
  tableTruncated: {
    padding: spacing.sm,
    fontSize: 12,
    color: colors.textMuted
  },
  list: {
    gap: spacing.xs
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm
  },
  listMarker: {
    width: 22,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily
  },
  listText: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  }
})
