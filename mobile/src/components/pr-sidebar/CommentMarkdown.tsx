import { MobileMarkdownCodeBlock } from '../MobileMarkdownCodeBlock'
import { createThemedStyles } from '../../theme/mobile-themed-styles'
import { useMobileTheme } from '../../theme/use-mobile-theme'
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { openExternalLink } from '../../platform/external-link'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { MermaidDiagram } from './MermaidDiagram'
import { isAllowedMarkdownLinkUrl } from './markdown-link-scheme'
import {
  parseInline,
  parseMarkdownBlocks,
  type CellAlign,
  type InlineToken,
  type MarkdownBlock
} from './markdown-blocks'

type Props = {
  content: string
  // PR body uses a slightly larger base than inline comment cards (mirrors desktop).
  variant?: 'document' | 'comment'
}

// Themed, dependency-free markdown for PR bodies + comments — the RN analogue of
// the desktop CommentMarkdown. The previous third-party renderer hung the JS thread
// on mount; this renders a small block model and falls back to plain text on any
// parse error, so it can never crash the comment list.
export function CommentMarkdown({ content, variant = 'comment' }: Props) {
  useMobileTheme()

  const base = variant === 'document' ? typography.bodySize : 13
  const blocks = useMemo<MarkdownBlock[] | null>(() => {
    try {
      return parseMarkdownBlocks(content)
    } catch {
      return null
    }
  }, [content])

  if (!blocks) {
    return (
      <Text style={[styles.paragraph, { fontSize: base, lineHeight: base + 7 }]}>{content}</Text>
    )
  }

  return (
    <View>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} base={base} />
      ))}
    </View>
  )
}

function DetailsBlock({
  summary,
  body,
  base
}: {
  summary: string
  body: MarkdownBlock[]
  base: number
}) {
  useMobileTheme()

  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={styles.details}>
      <Pressable
        style={styles.detailsSummary}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
      >
        <Chevron size={14} color={colors.textSecondary} strokeWidth={2.2} />
        <Text style={[styles.detailsSummaryText, { fontSize: base }]}>{summary}</Text>
      </Pressable>
      {open ? (
        <View style={styles.detailsBody}>
          {body.map((b, i) => (
            <BlockView key={i} block={b} base={base} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

function BlockView({ block, base }: { block: MarkdownBlock; base: number }) {
  useMobileTheme()

  switch (block.kind) {
    case 'details':
      return <DetailsBlock summary={block.summary} body={block.body} base={base} />
    case 'heading':
      return (
        <Text style={[styles.heading, { fontSize: base + Math.max(0, 4 - block.level) }]}>
          {renderInline(block.text, base)}
        </Text>
      )
    case 'code':
      // Mermaid fences render as diagrams rather than raw code.
      if (block.lang === 'mermaid') {
        return <MermaidDiagram source={block.text} base={base} />
      }
      return (
        <MobileMarkdownCodeBlock
          code={block.text}
          language={block.lang}
          fontSize={base - 1}
          style={{ marginBottom: spacing.sm }}
        />
      )
    case 'table':
      return <TableBlock block={block} base={base} />
    case 'quote':
      return (
        <View style={styles.quote}>
          <Text style={[styles.paragraph, { fontSize: base, lineHeight: base + 7 }]}>
            {renderInline(block.text, base)}
          </Text>
        </View>
      )
    case 'hr':
      return <View style={styles.hr} />
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.listItem}>
              <Text style={[styles.bullet, { fontSize: base }]}>
                {block.ordered ? `${i + 1}.` : '•'}
              </Text>
              <Text
                style={[
                  styles.paragraph,
                  styles.listItemText,
                  { fontSize: base, lineHeight: base + 7 }
                ]}
              >
                {renderInline(item, base)}
              </Text>
            </View>
          ))}
        </View>
      )
    case 'paragraph':
      return (
        <Text style={[styles.paragraph, { fontSize: base, lineHeight: base + 7 }]}>
          {renderInline(block.text, base)}
        </Text>
      )
  }
}

function openMarkdownLink(url: string): void {
  if (!isAllowedMarkdownLinkUrl(url)) {
    return
  }
  openExternalLink(url)
}

function alignToFlex(align: CellAlign | undefined): 'flex-start' | 'center' | 'flex-end' {
  if (align === 'center') {
    return 'center'
  }
  if (align === 'right') {
    return 'flex-end'
  }
  return 'flex-start'
}

// GFM table rendered with Views. A horizontal ScrollView keeps wide tables from
// breaking the sidebar layout; fixed-width columns give cells room to sit side by side.
function TableBlock({
  block,
  base
}: {
  block: Extract<MarkdownBlock, { kind: 'table' }>
  base: number
}) {
  useMobileTheme()

  const columnCount = Math.max(block.headers.length, ...block.rows.map((r) => r.length), 1)
  const columns = Array.from({ length: columnCount }, (_, c) => c)
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tableScroll}
      contentContainerStyle={styles.table}
    >
      <View>
        <View style={[styles.tableRow, styles.tableHeaderRow]}>
          {columns.map((c) => (
            <View key={c} style={[styles.tableCell, { alignItems: alignToFlex(block.align[c]) }]}>
              <Text style={[styles.tableHeaderText, { fontSize: base - 1 }]}>
                {renderInline(block.headers[c] ?? '', base)}
              </Text>
            </View>
          ))}
        </View>
        {block.rows.map((row, r) => (
          <View key={r} style={styles.tableRow}>
            {columns.map((c) => (
              <View key={c} style={[styles.tableCell, { alignItems: alignToFlex(block.align[c]) }]}>
                <Text style={[styles.tableCellText, { fontSize: base - 1 }]}>
                  {renderInline(row[c] ?? '', base)}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function renderInline(text: string, base: number) {
  let tokens: InlineToken[]
  try {
    tokens = parseInline(text)
  } catch {
    tokens = [{ kind: 'text', text }]
  }
  const codeOccurrences = new Map<string, number>()
  return (
    <>
      {tokens.map((token, i) => {
        if (token.kind === 'bold') {
          return (
            <Text key={i} style={styles.bold}>
              {token.text}
            </Text>
          )
        }
        if (token.kind === 'italic') {
          return (
            <Text key={i} style={styles.italic}>
              {token.text}
            </Text>
          )
        }
        if (token.kind === 'code') {
          const occurrence = codeOccurrences.get(token.text) ?? 0
          codeOccurrences.set(token.text, occurrence + 1)
          return (
            <Text
              key={`${token.kind}:${token.text}:${occurrence}`}
              style={[styles.codeInline, { fontSize: base - 1 }]}
            >
              {token.text}
            </Text>
          )
        }
        if (token.kind === 'link') {
          return (
            <Text key={i} style={styles.link} onPress={() => openMarkdownLink(token.url)}>
              {token.text}
            </Text>
          )
        }
        return <Text key={i}>{token.text}</Text>
      })}
    </>
  )
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    paragraph: { color: colors.textPrimary, marginBottom: spacing.sm },
    heading: { color: colors.textPrimary, fontWeight: '700', marginBottom: spacing.xs },
    bold: { fontWeight: '700' },
    italic: { fontStyle: 'italic' },
    link: { color: colors.textPrimary, textDecorationLine: 'underline' },
    codeInline: {
      color: colors.textPrimary,
      fontFamily: typography.monoFamily,
      backgroundColor: colors.bgRaised
    },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: colors.borderSubtle,
      backgroundColor: colors.bgPanel,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      marginBottom: spacing.sm
    },
    hr: { height: 1, backgroundColor: colors.borderSubtle, marginVertical: spacing.sm },
    list: { marginBottom: spacing.sm },
    listItem: { flexDirection: 'row', gap: spacing.xs },
    listItemText: { flex: 1, marginBottom: 2 },
    bullet: { color: colors.textSecondary },
    details: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      borderRadius: radii.row,
      marginBottom: spacing.sm,
      overflow: 'hidden'
    },
    detailsSummary: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      backgroundColor: colors.bgRaised
    },
    detailsSummaryText: { color: colors.textPrimary, fontWeight: '600', flexShrink: 1 },
    detailsBody: { paddingHorizontal: spacing.sm, paddingTop: spacing.xs },
    tableScroll: { marginBottom: spacing.sm },
    table: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      borderRadius: radii.row,
      overflow: 'hidden'
    },
    tableRow: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle
    },
    tableHeaderRow: { borderTopWidth: 0, backgroundColor: colors.bgPanel },
    tableCell: {
      minWidth: 96,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.borderSubtle
    },
    tableHeaderText: { color: colors.textPrimary, fontWeight: '700' },
    tableCellText: { color: colors.textPrimary }
  })
)
