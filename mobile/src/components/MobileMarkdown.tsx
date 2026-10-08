import { Fragment, memo, useContext, useMemo, type ReactNode } from 'react'
import { Pressable, ScrollView, Text as NativeText, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from './inline-text-selection'
import { MarkdownImageView } from './markdown-image-view'
import { renderInline } from './markdown-inline-render'
import { MarkdownText, MarkdownTextContext, type MarkdownTextSetup } from './markdown-text'
import { MobileSelectableText } from './MobileSelectableText'
import { styles } from './mobile-markdown-styles'
import { openMarkdownImage } from './markdown-href-routing'
import { isMobileMermaidLanguage } from './mobile-mermaid-language'
import { useMobileMarkdownBlocks } from './use-mobile-markdown-blocks'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat-visual-directive'
import { MermaidDiagram } from './pr-sidebar/MermaidDiagram'

type Props = {
  content?: string
  fallback?: string
  /** Enables iOS range selection for native-chat transcript prose. */
  rangeSelectable?: boolean
  /** Forward long presses from interactive Android transcript spans to the message. */
  onLongPress?: () => void
  /** Multiplier for the rendered font size (paragraphs, lists, headings, quotes,
   *  code, table cells, and inline image thumbnails). Defaults to 1; the chat view
   *  passes >1 so agent prose reads larger than the compact base. */
  textScale?: number
  /** When provided, detected file paths and file-target hrefs render as tappable
   *  and invoke this with the path text (worktree-relative or absolute, with an
   *  optional :line(:col) suffix). Omitted on screens with no file viewer, where
   *  paths render as plain text (no behavior change). */
  onOpenFile?: (pathText: string) => void
  /** Authored image src → data URL, resolved by the owner; an image whose src has an
   *  entry renders as a real image instead of the tappable fallback text. */
  imageSources?: Record<string, string>
  /** Image taps prefer this with the authored src (resolved against the document by
   *  the owner); without it, image taps route the src as a file href. */
  onOpenImage?: (rawSrc: string) => void
  /** Native-chat assistant prose only: renders `::orca-visual{...}` directive lines. Without it,
   *  a directive line is ordinary text. Must be referentially stable (this component is memoized). */
  renderVisual?: (directive: NativeChatVisualDirective, index: number) => ReactNode
}

const MAX_TABLE_ROWS = 40
const MAX_TABLE_COLUMNS = 8
/** A paragraph that is exactly one image token renders the image full width. */
const STANDALONE_IMAGE = /^!\[([^\]\n]*)\]\(([^)\n]+)\)$/
/** Prose base size — passed to MermaidDiagram fallback mono text. */
const MERMAID_BASE = 13

function MobileMarkdownContent({
  content,
  fallback = '',
  rangeSelectable = false,
  textScale = 1,
  onOpenFile,
  imageSources,
  onOpenImage,
  renderVisual
}: Props) {
  // Interactive children own their touches and must forward the row action.
  const setup = useContext(MarkdownTextContext)
  const rowLongPress = setup.androidTranscript ? setup.onLongPress : undefined
  const text = content?.trim() ?? ''
  const { blocks, directives } = useMobileMarkdownBlocks(text, renderVisual !== undefined)
  // Scale every text size; inline spans inherit fontSize from the wrapping Text.
  const scaled = (
    size: number,
    lineHeight = size + 6
  ): { fontSize: number; lineHeight: number } | null =>
    textScale !== 1 ? { fontSize: size * textScale, lineHeight: lineHeight * textScale } : null
  const proseScale = scaled(13) // paragraph, quote text, and list markers share the base
  const listScale = scaled(14)
  const headingScale = scaled(14)
  const headingLargeScale = scaled(15)
  const compactScale = scaled(12, 17) // code text and table cells share the base
  if (!text) {
    return fallback ? (
      <MarkdownText selectable={rangeSelectable} style={styles.paragraph}>
        {fallback}
      </MarkdownText>
    ) : null
  }
  const mermaidSourceOccurrences = new Map<string, number>()
  // Native-chat range selection is set on each block; nested inline spans inherit it.

  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        if (block.type === 'visual') {
          const directive = directives[block.index]
          return directive && renderVisual ? (
            <Fragment key={`visual:${block.index}:${directive.file}`}>
              {renderVisual(directive, block.index)}
            </Fragment>
          ) : null
        }
        if (block.type === 'heading') {
          return (
            <MarkdownText
              key={index}
              selectable
              style={
                block.level <= 2
                  ? [styles.heading, styles.headingLarge, headingLargeScale]
                  : [styles.heading, headingScale]
              }
            >
              {renderInline(block.text, onOpenFile, imageSources, onOpenImage, textScale)}
            </MarkdownText>
          )
        }
        if (block.type === 'quote') {
          return (
            <View key={index} style={styles.quote}>
              <MarkdownText selectable style={[styles.quoteText, proseScale]}>
                {renderInline(block.text, onOpenFile, imageSources, onOpenImage, textScale)}
              </MarkdownText>
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
              {block.language ? (
                <NativeText style={styles.codeLanguage}>{block.language}</NativeText>
              ) : null}
              <MarkdownText selectable style={[styles.codeText, compactScale]}>
                {block.text}
              </MarkdownText>
            </View>
          )
        }
        if (block.type === 'image') {
          return (
            <Pressable
              key={index}
              style={styles.imageFrame}
              onPress={() => openMarkdownImage(block.url, onOpenFile, onOpenImage)}
              onLongPress={rowLongPress}
            >
              <NativeText style={styles.link}>{block.alt || 'Open image'}</NativeText>
              <NativeText style={styles.imageCaption} numberOfLines={1}>
                {block.url}
              </NativeText>
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
                    <MarkdownText
                      key={cellIndex}
                      selectable
                      style={[styles.tableCell, styles.tableHeader, compactScale]}
                    >
                      {renderInline(header, onOpenFile, imageSources, onOpenImage, textScale)}
                    </MarkdownText>
                  ))}
                </View>
                {visibleRows.map((row, rowIndex) => (
                  <View key={rowIndex} style={styles.tableRow}>
                    {visibleHeaders.map((_, cellIndex) => (
                      <MarkdownText
                        key={cellIndex}
                        selectable
                        style={[styles.tableCell, compactScale]}
                      >
                        {renderInline(
                          row[cellIndex] ?? '',
                          onOpenFile,
                          imageSources,
                          onOpenImage,
                          textScale
                        )}
                      </MarkdownText>
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
        if (block.type === 'list') {
          return (
            <View key={index} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.listItem}>
                  <NativeText style={[styles.listMarker, proseScale]}>
                    {item.checked == null
                      ? block.ordered
                        ? `${itemIndex + 1}.`
                        : '-'
                      : item.checked
                        ? '[x]'
                        : '[ ]'}
                  </NativeText>
                  <MarkdownText selectable style={[styles.listText, listScale]}>
                    {renderInline(item.text, onOpenFile, imageSources, onOpenImage, textScale)}
                  </MarkdownText>
                </View>
              ))}
            </View>
          )
        }
        if (block.type === 'rule') {
          return <View key={index} style={styles.rule} />
        }
        const standaloneMatch = STANDALONE_IMAGE.exec(block.text)
        const standaloneUri = standaloneMatch ? imageSources?.[standaloneMatch[2]!] : undefined
        if (standaloneMatch && standaloneUri) {
          return (
            <MarkdownImageView
              key={index}
              uri={standaloneUri}
              alt={standaloneMatch[1] ?? ''}
              onPress={() => openMarkdownImage(standaloneMatch[2]!, onOpenFile, onOpenImage)}
            />
          )
        }
        return (
          <MarkdownText
            key={index}
            selectable={rangeSelectable}
            style={[styles.paragraph, proseScale]}
          >
            {block.text.split('\n').map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 ? '\n' : null}
                {renderInline(line, onOpenFile, imageSources, onOpenImage, textScale)}
              </Fragment>
            ))}
          </MarkdownText>
        )
      })}
    </View>
  )
}

function MobileMarkdownInner(props: Props): React.JSX.Element | null {
  const { rangeSelectable = false, onLongPress } = props
  // Other Markdown surfaces retain their existing selection behavior.
  const androidTranscript = rangeSelectable && !INLINE_TEXT_SELECTION
  const setup = useMemo<MarkdownTextSetup>(
    () => ({
      TextComponent: rangeSelectable && !androidTranscript ? MobileSelectableText : NativeText,
      androidTranscript,
      ...(onLongPress ? { onLongPress } : {})
    }),
    [rangeSelectable, androidTranscript, onLongPress]
  )
  return (
    <MarkdownTextContext.Provider value={setup}>
      <MobileMarkdownContent {...props} />
    </MarkdownTextContext.Provider>
  )
}

export const MobileMarkdown = memo(MobileMarkdownInner)
