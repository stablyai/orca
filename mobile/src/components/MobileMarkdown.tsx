import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { Linking, Pressable, ScrollView, Text, View } from 'react-native'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { styles } from './mobile-markdown-styles'
import {
  detectFilePathSegments,
  isFilePathCodeSpan,
  normalizeFilePath
} from './markdown-file-path-detection'
import { parseMobileMarkdown } from './mobile-markdown-parser'

type Props = {
  content?: string
  fallback?: string
  /** Multiplier for prose font size (paragraphs, lists, quotes). Defaults to 1;
   *  the chat view passes >1 so agent prose reads larger than the compact base. */
  textScale?: number
  /** When provided, detected file-path tokens render as tappable and invoke this
   *  with the worktree-relative path. Omitted on screens with no file viewer, where
   *  paths render as plain text (no behavior change). */
  onOpenFile?: (relativePath: string) => void
}

const MAX_TABLE_ROWS = 40
const MAX_TABLE_COLUMNS = 8

function openMarkdownUrl(url: string): void {
  const trimmed = url.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) {
    void Linking.openURL(trimmed).catch(() => {})
  }
}

// Render a plain (non-token) text run, splitting out tappable file paths when
// onOpenFile is provided. Without it, paths stay plain text.
function renderTextRun(
  text: string,
  keyPrefix: string,
  onOpenFile?: (relativePath: string) => void
): ReactNode {
  if (!onOpenFile) {
    return text
  }
  const segments = detectFilePathSegments(text)
  if (segments.length === 1 && segments[0]!.type === 'text') {
    return text
  }
  return segments.map((segment, segmentIndex) => {
    if (segment.type === 'file') {
      return (
        <Text
          key={`${keyPrefix}:${segmentIndex}`}
          style={styles.link}
          onPress={() => onOpenFile(segment.path)}
        >
          {segment.value}
        </Text>
      )
    }
    return <Fragment key={`${keyPrefix}:${segmentIndex}`}>{segment.value}</Fragment>
  })
}

function renderInline(text: string, onOpenFile?: (relativePath: string) => void): ReactNode[] {
  const parts: ReactNode[] = []
  const pattern =
    /(!\[[^\]]*\]\([^)]+\)|`[^`]+`|~~[^~]+~~|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<]+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      parts.push(renderTextRun(text.slice(lastIndex, match.index), `t${lastIndex}`, onOpenFile))
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
      const code = token.slice(1, -1)
      if (onOpenFile && isFilePathCodeSpan(code)) {
        parts.push(
          <Text
            key={key}
            style={[styles.inlineCode, styles.inlineCodeLink]}
            onPress={() => onOpenFile(normalizeFilePath(code.trim()))}
          >
            {code}
          </Text>
        )
      } else {
        parts.push(
          <Text key={key} style={styles.inlineCode}>
            {code}
          </Text>
        )
      }
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
    parts.push(renderTextRun(text.slice(lastIndex), `t${lastIndex}`, onOpenFile))
  }
  return parts
}

function MobileMarkdownInner({ content, fallback = '', textScale = 1, onOpenFile }: Props) {
  const text = content?.trim() ?? ''
  const previewText = useMemo(() => normalizeMobileMarkdownPreviewHtml(text), [text])
  const blocks = useMemo(() => parseMobileMarkdown(previewText), [previewText])
  // Scale prose sizes; inline spans inherit fontSize from the wrapping Text.
  const scaled = (size: number): { fontSize: number; lineHeight: number } | null =>
    textScale !== 1 ? { fontSize: size * textScale, lineHeight: (size + 6) * textScale } : null
  const proseScale = scaled(13)
  const listScale = scaled(14)
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
              {renderInline(block.text, onOpenFile)}
            </Text>
          )
        }
        if (block.type === 'quote') {
          return (
            <View key={index} style={styles.quote}>
              <Text style={styles.quoteText}>{renderInline(block.text, onOpenFile)}</Text>
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
                      {renderInline(header, onOpenFile)}
                    </Text>
                  ))}
                </View>
                {visibleRows.map((row, rowIndex) => (
                  <View key={rowIndex} style={styles.tableRow}>
                    {visibleHeaders.map((_, cellIndex) => (
                      <Text key={cellIndex} style={styles.tableCell}>
                        {renderInline(row[cellIndex] ?? '', onOpenFile)}
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
                  <Text style={[styles.listText, listScale]}>
                    {renderInline(item.text, onOpenFile)}
                  </Text>
                </View>
              ))}
            </View>
          )
        }
        if (block.type === 'rule') {
          return <View key={index} style={styles.rule} />
        }
        return (
          <Text key={index} style={[styles.paragraph, proseScale]}>
            {block.text.split('\n').map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 ? '\n' : null}
                {renderInline(line, onOpenFile)}
              </Fragment>
            ))}
          </Text>
        )
      })}
    </View>
  )
}

export const MobileMarkdown = memo(MobileMarkdownInner)
