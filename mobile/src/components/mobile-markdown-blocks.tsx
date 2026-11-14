import { renderImageParagraph } from './mobile-markdown-image-paragraph'
import {
  mobileMarkdownBlockIsLiteral,
  mobileMarkdownNestedBlocks,
  mobileMarkdownParagraphImages
} from './mobile-markdown-image-placement'
import type { Code, List, Nodes, RootContent, Table } from 'mdast'
import { Fragment, type ReactNode } from 'react'
import { Square, SquareCheck } from 'lucide-react-native'
import {
  Pressable,
  ScrollView,
  Text as NativeText,
  View,
  type StyleProp,
  type TextStyle
} from 'react-native'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { isMobileMermaidLanguage } from './mobile-mermaid-language'
import { mobileMathMeasureText } from './mobile-markdown-math-nodes'
import { mobileMarkdownTableColumnWidths } from './mobile-markdown-table-columns'
import { mobileMarkdownVisualPlaceholderIndex } from './mobile-markdown-visual-lines'
import {
  openMarkdownHref,
  renderInline,
  type MarkdownInlineContext
} from './mobile-markdown-inline'
import { MARKDOWN_TONES, scaledMarkdownText, styles } from './mobile-markdown-styles'
import { MarkdownText } from './mobile-markdown-text'
import { codeFenceClosed } from './mobile-markdown-code-nodes'
import { plainText } from './mobile-markdown-plain-text'
import { MermaidDiagram } from './pr-sidebar/MermaidDiagram'
import { MobileMarkdownCallout } from './MobileMarkdownCallout'
import { MobileMarkdownCodeBlock } from './MobileMarkdownCodeBlock'
import { MobileMarkdownDetails } from './MobileMarkdownDetails'
import { MobileMarkdownMath } from './MobileMarkdownMath'
import { drawnBlock } from './mobile-markdown-drawn-blocks'
import { translate } from '../i18n/mobile-i18n'
import { colors, pressedStyle } from '../theme/mobile-theme'

/** Prose base size — passed to MermaidDiagram fallback mono text. */
const MERMAID_BASE = 13

/** A field added here is compared in mobile-markdown-drawn-blocks' `sameContext` too. */
export type MarkdownBlockContext = MarkdownInlineContext & {
  /** The text is still arriving: a diagram stays code until it stops. */
  growing: boolean
  listText: StyleProp<TextStyle>
  listMarker: StyleProp<TextStyle>
  /** Interactive children own their touches and must forward the row action. */
  rowLongPress?: () => void
  directives: readonly NativeChatVisualDirective[]
  /** Null or undefined leaves the image a link. */
  renderImage?: (href: string, alt: string, width?: number) => ReactNode
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
    <MobileMarkdownCodeBlock
      key={key}
      code={node.value}
      language={node.lang ?? undefined}
      textScale={ctx.textScale}
      sourceLine={node.position?.start.line}
    />
  )
}

function renderList(node: List, key: number, ctx: MarkdownBlockContext, depth: number): ReactNode {
  const nested = mobileMarkdownNestedBlocks(node, depth)
  const itemText: ParagraphText = { style: ctx.listText, selectable: true }
  return (
    <View key={key} style={styles.list}>
      {node.children.map((item, itemIndex) => (
        <View key={itemIndex} style={styles.listItem}>
          {item.checked == null ? (
            <NativeText style={ctx.listMarker}>
              {node.ordered ? `${(node.start ?? 1) + itemIndex}.` : '•'}
            </NativeText>
          ) : (
            // A GitHub task's read-only box, centred on the item's first line.
            <View
              // ARIA props, which react-native-web reads too; a read-only box takes no keyboard stop.
              accessible
              focusable={false}
              role="checkbox"
              aria-checked={Boolean(item.checked)}
              aria-disabled
              style={[styles.taskMarker, { height: styles.listText.lineHeight * ctx.textScale }]}
            >
              {item.checked ? (
                <SquareCheck size={14 * ctx.textScale} color={colors.accentBlue} strokeWidth={2} />
              ) : (
                <Square size={14 * ctx.textScale} color={colors.textSecondary} strokeWidth={2} />
              )}
            </View>
          )}
          <View style={styles.listItemBody}>
            {renderBlocks(nested[itemIndex]!.nodes, ctx, itemText, nested[itemIndex]!.depth)}
          </View>
        </View>
      ))}
    </View>
  )
}

/** What a cell draws, with each formula as wide as it typesets rather than as its TeX. */
function cellText(node: Nodes): string {
  if (node.type === 'inlineMath') {
    return mobileMathMeasureText(node.value)
  }
  return 'children' in node ? node.children.map(cellText).join('') : plainText(node)
}

function renderTable(node: Table, key: number, ctx: MarkdownBlockContext): ReactNode {
  const rows = node.children.map((row) => row.children)
  // Rows lay out independently, so a shared width per column is what lines them up.
  const columnWidths = mobileMarkdownTableColumnWidths(
    rows.map((cells) => cells.map(cellText)),
    ctx.textScale
  )
  // A table keeps its own dark surface, so its spans keep the default palette.
  const cellCtx = { ...ctx, tone: MARKDOWN_TONES.default }
  return (
    <ScrollView
      key={key}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.tableScroll}
    >
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
                  { width, textAlign: node.align?.[cellIndex] ?? 'left' }
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
  if (mobileMarkdownBlockIsLiteral(node, depth)) {
    return (
      <MarkdownText key={key} selectable={text.selectable} style={text.style}>
        {plainText(node)}
      </MarkdownText>
    )
  }
  const nested = mobileMarkdownNestedBlocks(node, depth)[0]
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
      const withImages = renderImageParagraph(
        node.children,
        mobileMarkdownParagraphImages(node, depth),
        key,
        ctx,
        text
      )
      if (withImages) {
        return withImages
      }
      if (node.children.length === 1 && only?.type === 'image' && /^https?:\/\//i.test(only.url)) {
        return (
          <Pressable
            key={key}
            style={({ pressed }) => [styles.imageFrame, pressed && pressedStyle]}
            onPress={() => openMarkdownHref(only.url, ctx)}
            onLongPress={ctx.rowLongPress}
          >
            <NativeText style={styles.link}>
              {only.alt || translate('components.markdownBlocks.openImage', 'Open image')}
            </NativeText>
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
            node.depth === 1 ? styles.headingTitle : node.depth === 2 ? styles.headingLarge : null,
            scaledMarkdownText(
              node.depth === 1
                ? styles.headingTitle
                : node.depth === 2
                  ? styles.headingLarge
                  : styles.heading,
              ctx.textScale
            ),
            ctx.tone.text
          ]}
        >
          {renderInline(node.children, ctx)}
        </MarkdownText>
      )
    case 'blockquote':
      // A GitHub alert's body is ordinary text, not a muted quote.
      return node.data?.callout ? (
        <MobileMarkdownCallout key={key} kind={node.data.callout} textScale={ctx.textScale}>
          {renderBlocks(nested!.nodes, ctx, { style: text.style, selectable: true }, nested!.depth)}
        </MobileMarkdownCallout>
      ) : (
        <View key={key} style={styles.quote}>
          {renderBlocks(
            nested!.nodes,
            ctx,
            {
              style: [
                styles.quoteText,
                scaledMarkdownText(styles.quoteText, ctx.textScale),
                ctx.tone.secondary
              ],
              selectable: true
            },
            nested!.depth
          )}
        </View>
      )
    case 'code':
      return renderCode(node, key, ctx)
    case 'math':
      return (
        <MobileMarkdownMath
          key={key}
          value={node.value}
          source={node.source}
          display
          githubSizes={!ctx.chatMath}
          style={text.style}
        />
      )
    case 'list':
      return renderList(node, key, ctx, depth)
    case 'table':
      return renderTable(node, key, ctx)
    case 'thematicBreak':
      return <View key={key} style={styles.rule} />
    case 'details':
      return (
        <MobileMarkdownDetails
          key={key}
          open={node.open}
          summaryStyle={text.style}
          summary={
            node.summary.length > 0
              ? renderInline(node.summary, ctx)
              : translate('pullRequest.markdownBlocks.details', 'Details')
          }
        >
          {renderBlocks(nested!.nodes, ctx, text, nested!.depth)}
        </MobileMarkdownDetails>
      )
    case 'footnoteDefinition':
      return (
        <View key={key} style={styles.listItem}>
          <NativeText style={ctx.listMarker}>{`${node.label ?? node.identifier}.`}</NativeText>
          <View style={styles.listItemBody}>
            {renderBlocks(
              nested!.nodes,
              ctx,
              { style: ctx.listText, selectable: true },
              nested!.depth
            )}
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
    case 'inlineMath':
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
  return nodes.map((node, index) =>
    depth === 0
      ? drawnBlock(node, ctx, text, () => renderBlock(node, index, ctx, text, 0))
      : renderBlock(node, index, ctx, text, depth)
  )
}
