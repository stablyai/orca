import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { Linking, Pressable, ScrollView, Text, View } from 'react-native'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { styles } from './mobile-markdown-styles'
import {
  detectFilePathSegments,
  isFilePathCodeSpan,
  normalizeFilePath
} from './markdown-file-path-detection'
import { routeMarkdownHref } from './markdown-href-routing'
import {
  isIntrawordUnderscoreToken,
  trimAutolinkTrailingPunctuation
} from './markdown-inline-token-rules'
import { isMobileMermaidLanguage } from './mobile-mermaid-language'
import { parseMobileMarkdown } from './mobile-markdown-parser'
import { MermaidDiagram } from './pr-sidebar/MermaidDiagram'
import { t } from '@/i18n/mobile-i18n'

type Props = {
  content?: string
  fallback?: string
  /** Multiplier for prose font size (paragraphs, lists, quotes). Defaults to 1;
   *  the chat view passes >1 so agent prose reads larger than the compact base. */
  textScale?: number
  /** When provided, detected file paths and file-target hrefs render as tappable
   *  and invoke this with the path text (worktree-relative or absolute, with an
   *  optional :line(:col) suffix). Omitted on screens with no file viewer, where
   *  paths render as plain text (no behavior change). */
  onOpenFile?: (pathText: string) => void
}

const MAX_TABLE_ROWS = 40
const MAX_TABLE_COLUMNS = 8
/** Prose base size — passed to MermaidDiagram fallback mono text. */
const MERMAID_BASE = 13

// Web/mail hrefs open the system handler; file-target hrefs (file: URIs and
// scheme-less paths — the entire desktop file-link contract) go to onOpenFile.
function openMarkdownHref(href: string, onOpenFile?: (pathText: string) => void): void {
  const route = routeMarkdownHref(href)
  if (route.kind === 'web') {
    void Linking.openURL(route.url).catch(() => {})
    return
  }
  if (route.kind === 'file' && onOpenFile) {
    onOpenFile(route.pathText)
  }
}

// Render a plain (non-token) text run, splitting out tappable file paths when
// onOpenFile is provided. Without it, paths stay plain text.
function renderTextRun(
  text: string,
  keyPrefix: string,
  onOpenFile?: (pathText: string) => void
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

function renderInline(text: string, onOpenFile?: (pathText: string) => void): ReactNode[] {
  const parts: ReactNode[] = []
  const pattern =
    /(!\[[^\]]*\]\([^)]+\)|`[^`]+`|~~[^~]+~~|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<]+)/g
  let pendingStart = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    const token = match[0]
    // Intraword `_` runs (snake_case, dunder tails) are literal text per
    // CommonMark; leaving them unflushed keeps surrounding file paths whole
    // for detection in the eventual text run.
    if (token.startsWith('_') && isIntrawordUnderscoreToken(text, match.index, token)) {
      // Resume after the opener so real tokens inside the rejected span are still scanned.
      pattern.lastIndex = match.index + 1
      continue
    }
    if (match.index > pendingStart) {
      parts.push(
        renderTextRun(text.slice(pendingStart, match.index), `t${pendingStart}`, onOpenFile)
      )
    }
    pendingStart = pattern.lastIndex
    const key = `${match.index}:${token}`
    const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (image) {
      parts.push(
        <Text key={key} style={styles.link} onPress={() => openMarkdownHref(image[2]!, onOpenFile)}>
          {image[1] || t('mobileMarkdown.image')}
        </Text>
      )
    } else if (link) {
      parts.push(
        <Text key={key} style={styles.link} onPress={() => openMarkdownHref(link[2]!, onOpenFile)}>
          {link[1]}
        </Text>
      )
    } else if (/^https?:\/\//i.test(token)) {
      const { url, trailing } = trimAutolinkTrailingPunctuation(token)
      parts.push(
        <Text key={key} style={styles.link} onPress={() => openMarkdownHref(url, onOpenFile)}>
          {url}
        </Text>
      )
      if (trailing) {
        parts.push(<Fragment key={`${key}p`}>{trailing}</Fragment>)
      }
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
          {renderTextRun(token.slice(2, -2), `${key}i`, onOpenFile)}
        </Text>
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      parts.push(
        <Text key={key} style={styles.bold}>
          {renderTextRun(token.slice(2, -2), `${key}i`, onOpenFile)}
        </Text>
      )
    } else {
      parts.push(
        <Text key={key} style={styles.italic}>
          {renderTextRun(token.slice(1, -1), `${key}i`, onOpenFile)}
        </Text>
      )
    }
  }

  if (pendingStart < text.length) {
    parts.push(renderTextRun(text.slice(pendingStart), `t${pendingStart}`, onOpenFile))
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
  const mermaidSourceOccurrences = new Map<string, number>()

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
          // Mermaid fences render as diagrams (WebView), not as raw code — same as PR sidebar.
          // Unclosed fences are still streaming: mounting the WebView per tick would
          // reload its document up to 20x/sec, so they stay raw code until terminated.
          if (isMobileMermaidLanguage(block.language) && block.closed) {
            const occurrence = mermaidSourceOccurrences.get(block.text) ?? 0
            mermaidSourceOccurrences.set(block.text, occurrence + 1)
            return (
              <MermaidDiagram
                key={`${block.text}:${occurrence}`}
                source={block.text}
                base={MERMAID_BASE}
              />
            )
          }
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
              onPress={() => openMarkdownHref(block.url, onOpenFile)}
            >
              <Text style={styles.link}>{block.alt || t('mobileMarkdown.open')}</Text>
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
                    {hiddenRows > 0
                      ? t('mobileMarkdown.hiddenRow', {
                          hiddenRowCount: hiddenRows
                        })
                      : ''}
                    {hiddenRows > 0 && hiddenColumns > 0 ? ' · ' : ''}
                    {hiddenColumns > 0
                      ? t('mobileMarkdown.hiddenColumn', {
                          hiddenColumnCount: hiddenColumns
                        })
                      : ''}
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
                        ? t('mobileMarkdown.x')
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
