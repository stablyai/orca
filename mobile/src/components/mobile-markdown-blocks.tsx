import { MobileMarkdownTable } from './MobileMarkdownTable'
import { MobileMarkdownCodeBlock } from './MobileMarkdownCodeBlock'
import type { Code, List, RootContent } from 'mdast'
import { Fragment, type ReactNode } from 'react'
import { Pressable, Text as NativeText, View, type StyleProp, type TextStyle } from 'react-native'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat-visual-directive'
import { isMobileMermaidLanguage } from './mobile-mermaid-language'
import { mobileMarkdownVisualPlaceholderIndex } from './mobile-markdown-visual-lines'
import {
  openMarkdownHref,
  renderInline,
  type MarkdownInlineContext
} from './mobile-markdown-inline'
import { styles } from './mobile-markdown-styles'
import { MarkdownText } from './mobile-markdown-text'
import { codeFenceClosed, plainText } from './mobile-markdown-tree'
import { MermaidDiagram } from './pr-sidebar/MermaidDiagram'

/** Prose base size — passed to MermaidDiagram fallback mono text. */
const MERMAID_BASE = 13
/** Containers nested deeper than this draw as plain text, so a pathological nesting cannot
 *  exhaust native layout. */
const MAX_NESTING = 8

export type MarkdownBlockContext = MarkdownInlineContext & {
  /** The text is still arriving: a diagram stays code until it stops. */
  growing: boolean
  codeSelectable: boolean
  textScale: number
  listText: StyleProp<TextStyle>
  /** Interactive children own their touches and must forward the row action. */
  rowLongPress?: () => void
  directives: readonly NativeChatVisualDirective[]
  renderVisual?: (directive: NativeChatVisualDirective, index: number) => ReactNode
  mermaidOccurrences: Map<string, number>
}

/** How a paragraph draws in the container holding it. */
export type ParagraphText = { style: StyleProp<TextStyle>; selectable: boolean }

function renderCode(node: Code, key: number, ctx: MarkdownBlockContext): ReactNode {
  // Mermaid fences render as diagrams (WebView), not as raw code — same as PR sidebar.
  // Growing or unclosed fences are still streaming: mounting the WebView per tick would
  // reload its document up to 20x/sec, so they stay raw code until done.
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
      selectable={ctx.codeSelectable}
      language={node.lang ?? undefined}
      fontSize={12 * ctx.textScale}
      lineHeight={17 * ctx.textScale}
    />
  )
}

function renderList(node: List, key: number, ctx: MarkdownBlockContext, depth: number): ReactNode {
  const itemText: ParagraphText = { style: ctx.listText, selectable: true }
  return (
    <View key={key} style={styles.list}>
      {node.children.map((item, itemIndex) => (
        <View key={itemIndex} style={styles.listItem}>
          <NativeText
            style={[
              styles.listMarker,
              { fontSize: 13 * ctx.textScale, lineHeight: 19 * ctx.textScale },
              ctx.tone.secondary
            ]}
          >
            {item.checked == null
              ? node.ordered
                ? `${(node.start ?? 1) + itemIndex}.`
                : '•'
              : item.checked
                ? '☑'
                : '☐'}
          </NativeText>
          <View style={styles.listItemBody}>
            {renderBlocks(item.children, ctx, itemText, depth + 1)}
          </View>
        </View>
      ))}
    </View>
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
          {renderInline(node.children, ctx, text.style)}
        </MarkdownText>
      )
    }
    case 'heading': {
      const headingText = [
        styles.heading,
        {
          fontSize: (node.depth <= 2 ? 15 : 14) * ctx.textScale,
          lineHeight: (node.depth <= 2 ? 21 : 20) * ctx.textScale
        },
        ctx.tone.text
      ]
      return (
        <MarkdownText key={key} selectable style={headingText}>
          {renderInline(node.children, ctx, headingText)}
        </MarkdownText>
      )
    }
    case 'blockquote':
      return (
        <View key={key} style={styles.quote}>
          {renderBlocks(
            node.children,
            ctx,
            {
              style: [
                styles.quoteText,
                { fontSize: 13 * ctx.textScale, lineHeight: 19 * ctx.textScale },
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
      return <MobileMarkdownTable key={key} node={node} ctx={ctx} />
    case 'thematicBreak':
      return <View key={key} style={styles.rule} />
    case 'footnoteDefinition':
      return (
        <View key={key} style={styles.listItem}>
          <NativeText
            style={[
              styles.listMarker,
              { fontSize: 13 * ctx.textScale, lineHeight: 19 * ctx.textScale },
              ctx.tone.secondary
            ]}
          >{`[${node.label ?? node.identifier}]`}</NativeText>
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
