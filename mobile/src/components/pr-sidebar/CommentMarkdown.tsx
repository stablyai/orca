import { useMemo, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import {
  parseInline,
  parseMarkdownBlocks,
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
  switch (block.kind) {
    case 'details':
      return <DetailsBlock summary={block.summary} body={block.body} base={base} />
    case 'heading':
      return (
        <Text style={[styles.heading, { fontSize: base + Math.max(0, 4 - block.level) }]}>
          <Inline text={block.text} base={base} />
        </Text>
      )
    case 'code':
      return (
        <View style={styles.codeBlock}>
          <Text style={[styles.codeText, { fontSize: base - 1 }]}>{block.text}</Text>
        </View>
      )
    case 'quote':
      return (
        <View style={styles.quote}>
          <Text style={[styles.paragraph, { fontSize: base, lineHeight: base + 7 }]}>
            <Inline text={block.text} base={base} />
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
                <Inline text={item} base={base} />
              </Text>
            </View>
          ))}
        </View>
      )
    case 'paragraph':
      return (
        <Text style={[styles.paragraph, { fontSize: base, lineHeight: base + 7 }]}>
          <Inline text={block.text} base={base} />
        </Text>
      )
  }
}

function Inline({ text, base }: { text: string; base: number }) {
  const tokens = useMemo<InlineToken[]>(() => {
    try {
      return parseInline(text)
    } catch {
      return [{ kind: 'text', text }]
    }
  }, [text])
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
          return (
            <Text key={i} style={[styles.codeInline, { fontSize: base - 1 }]}>
              {token.text}
            </Text>
          )
        }
        if (token.kind === 'link') {
          return (
            <Text key={i} style={styles.link} onPress={() => void Linking.openURL(token.url)}>
              {token.text}
            </Text>
          )
        }
        return <Text key={i}>{token.text}</Text>
      })}
    </>
  )
}

const styles = StyleSheet.create({
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
  codeBlock: {
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    padding: spacing.sm,
    marginBottom: spacing.sm
  },
  codeText: { color: colors.textPrimary, fontFamily: typography.monoFamily },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
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
  detailsBody: { paddingHorizontal: spacing.sm, paddingTop: spacing.xs }
})
