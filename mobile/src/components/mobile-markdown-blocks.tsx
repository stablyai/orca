import type { Code, List, RootContent, Table } from 'mdast'
import { Fragment, type ReactNode } from 'react'
import {
  Pressable,
  ScrollView,
  Text as NativeText,
  View,
  type StyleProp,
  type TextStyle
} from 'react-native'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat-visual-directive'
import { isMobileMermaidLanguage } from './mobile-mermaid-language'
import { mobileMarkdownTableColumnWidths } from './mobile-markdown-table-columns'
import { mobileMarkdownVisualPlaceholderIndex } from './mobile-markdown-visual-lines'
import {
  openMarkdownHref,
  renderInline,
  type MarkdownInlineContext
} from './mobile-markdown-inline'
import { MARKDOWN_TONES, scaledMarkdownText, styles } from './mobile-markdown-styles'
import { MarkdownText } from './mobile-markdown-text'
import { codeFenceClosed, plainText } from './mobile-markdown-tree'
import { MermaidDiagram } from './pr-sidebar/MermaidDiagram'
import { MobileSourceCopyButton } from './MobileSourceCopyButton'

/** Prose base size — passed to MermaidDiagram fallback mono text. */
const MERMAID_BASE = 13
/** Containers nested deeper than this draw as plain text, so a pathological nesting cannot
 *  exhaust native layout. */
const MAX_NESTING = 8

export type MarkdownBlockContext = MarkdownInlineContext & {
  /** The text is still arriving: a diagram stays code until it stops. */
  growing: boolean
  listText: StyleProp<TextStyle>
  /** Interactive children own their touches and must forward the row action. */
  rowLongPress?: () => void
  directives: readonly NativeChatVisualDirective[]
  renderImage?: (href: string, alt: string) => ReactNode
  renderVisual?: (directive: NativeChatVisualDirective, index: number) => ReactNode
  mermaidOccurrences: Map<string, number>
}

/** How a paragraph draws in the container holding it. */
export type ParagraphText = { style: StyleProp<TextStyle>; selectable: boolean }

function renderCode(node: Code, key: number, ctx: MarkdownBlockContext): ReactNode {
  // Keep streaming/unclosed Mermaid fences as code; per-tick WebView mounts would reload document up to 20x/sec. Render diagram only once complete.
  if (isMobileMermaidLanguage(node.lang ?? undefined) && !ctx.growing && codeFenceClosed(node)) {
    const occurrence = ctx.mermaidOccurrences.get(node.value) ?? 0
    ctx.mermaidOccurrences.set(node.value, occurrence + 1)
    return (
      <MermaidDiagram key={`${node.value}:${occurrence}`} source={node.value} base={MERMAID_BASE} />
    )
  }
  return (
    <View key={key} style={styles.codeBlock}>
      <View style={styles.codeBody}>
        {node.lang ? <NativeText style={styles.codeLanguage}>{node.lang}</NativeText> : null}
        <MarkdownText
          selectable
          style={[styles.codeText, scaledMarkdownText(styles.codeText, ctx.textScale)]}
        >
          {node.value}
        </MarkdownText>
      </View>
      {node.value ? (
        <MobileSourceCopyButton text={node.value} accessibilityLabel="Copy code" />
      ) : null}
    </View>
  )
}

function renderList(node: List, key: number, ctx: MarkdownBlockContext, depth: number): ReactNode {
  const itemText: ParagraphText = { style: ctx.listText, selectable: true }
  return (
    <View key={key} style={styles.list}>
      {node.children.map((item, itemIndex) => (
        <View key={itemIndex} style={styles.listItem}>
          <NativeText style={[styles.listMarker, ctx.tone.secondary]}>
            {item.checked == null
              ? node.ordered
                ? `${(node.start ?? 1) + itemIndex}.`
                : '-'
              : item.checked
                ? '[x]'
                : '[ ]'}
          </NativeText>
          <View style={styles.listItemBody}>
            {renderBlocks(item.children, ctx, itemText, depth + 1)}
          </View>
        </View>
      ))}
    </View>
  )
}

function renderTable(node: Table, key: number, ctx: MarkdownBlockContext): ReactNode {
  const rows = node.children.map((row) => row.children)
  // Rows lay out independently, so a shared width per column is what lines them up.
  const columnWidths = mobileMarkdownTableColumnWidths(
    rows.map((cells) => cells.map((cell) => plainText(cell)))
  )
  // A table keeps its own dark surface, so its spans keep the default palette.
  const cellCtx = { ...ctx, tone: MARKDOWN_TONES.default }
  return (
    <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.table}>
        {rows.map((cells, rowIndex) => (
          <View key={rowIndex} style={styles.tableRow}>
            {columnWidths.map((width, cellIndex) => (
              <MarkdownText
                key={cellIndex}
                selectable
                style={[
                  styles.tableCell,
                  rowIndex === 0 ? styles.tableHeader : null,
                  scaledMarkdownText(styles.tableCell, ctx.textScale),
                  { width: width * ctx.textScale, textAlign: node.align?.[cellIndex] ?? 'left' }
                ]}
              >
                {renderInline(cells[cellIndex]?.children ?? [], cellCtx)}
              </MarkdownText>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function renderBlock(
  node: RootContent,
  key: number,
  ctx: MarkdownBlockContext,
  text: ParagraphText,
  depth: number
): ReactNode {
  if (depth > MAX_NESTING && 'children' in node) {
    return (
      <MarkdownText key={key} selectable={text.selectable} style={text.style}>
        {plainText(node)}
      </MarkdownText>
    )
  }
  switch (node.type) {
    case 'paragraph': {
      const [only] = node.children
      const visual =
        node.children.length === 1 && only?.type === 'text'
          ? mobileMarkdownVisualPlaceholderIndex(only.value, ctx.directives.length)
          : null
      if (visual !== null) {
        const directive = ctx.directives[visual]
        return directive && ctx.renderVisual ? (
          <Fragment key={`visual:${visual}:${directive.file}`}>
            {ctx.renderVisual(directive, visual)}
          </Fragment>
        ) : null
      }
      if (node.children.length === 1 && only?.type === 'image' && ctx.renderImage) {
        return <Fragment key={key}>{ctx.renderImage(only.url, only.alt ?? '')}</Fragment>
      }
      if (node.children.length === 1 && only?.type === 'image' && /^https?:\/\//i.test(only.url)) {
        return (
          <Pressable
            key={key}
            style={styles.imageFrame}
            onPress={() => openMarkdownHref(only.url, ctx.onOpenFile)}
            onLongPress={ctx.rowLongPress}
          >
            <NativeText style={styles.link}>{only.alt || 'Open image'}</NativeText>
            <NativeText style={styles.imageCaption} numberOfLines={1}>
              {only.url}
            </NativeText>
          </Pressable>
        )
      }
      return (
        <MarkdownText key={key} selectable={text.selectable} style={text.style}>
          {renderInline(node.children, ctx)}
        </MarkdownText>
      )
    }
    case 'heading':
      return (
        <MarkdownText
          key={key}
          selectable
          style={[
            styles.heading,
            node.depth <= 2 ? styles.headingLarge : null,
            scaledMarkdownText(
              node.depth <= 2 ? styles.headingLarge : styles.heading,
              ctx.textScale
            ),
            ctx.tone.text
          ]}
        >
          {renderInline(node.children, ctx)}
        </MarkdownText>
      )
    case 'blockquote':
      return (
        <View key={key} style={styles.quote}>
          {renderBlocks(
            node.children,
            ctx,
            {
              style: [
                styles.quoteText,
                scaledMarkdownText(styles.quoteText, ctx.textScale),
                ctx.tone.secondary
              ],
              selectable: true
            },
            depth + 1
          )}
        </View>
      )
    case 'code':
      return renderCode(node, key, ctx)
    case 'list':
      return renderList(node, key, ctx, depth)
    case 'table':
      return renderTable(node, key, ctx)
    case 'thematicBreak':
      return <View key={key} style={styles.rule} />
    case 'footnoteDefinition':
      return (
        <View key={key} style={styles.listItem}>
          <NativeText style={[styles.listMarker, ctx.tone.secondary]}>
            {`[${node.label ?? node.identifier}]`}
          </NativeText>
          <View style={styles.listItemBody}>
            {renderBlocks(node.children, ctx, { style: ctx.listText, selectable: true }, depth + 1)}
          </View>
        </View>
      )
    case 'html':
      return (
        <MarkdownText key={key} selectable={text.selectable} style={text.style}>
          {node.value}
        </MarkdownText>
      )
    // Inline content never sits at block level in a parsed tree; drawn as text if it does.
    case 'break':
    case 'delete':
    case 'emphasis':
    case 'footnoteReference':
    case 'image':
    case 'imageReference':
    case 'inlineCode':
    case 'link':
    case 'linkReference':
    case 'strong':
    case 'text':
      return (
        <MarkdownText key={key} selectable={text.selectable} style={text.style}>
          {renderInline([node], ctx)}
        </MarkdownText>
      )
    case 'definition':
    case 'listItem':
    case 'tableCell':
    case 'tableRow':
    case 'yaml':
      return null
  }
}

/** Block content as views; `text` is how paragraphs draw in the container holding them. */
export function renderBlocks(
  nodes: readonly RootContent[],
  ctx: MarkdownBlockContext,
  text: ParagraphText,
  depth = 0
): ReactNode[] {
  return nodes.map((node, index) => renderBlock(node, index, ctx, text, depth))
}
