import type { PhrasingContent } from 'mdast'
import { Fragment, type ReactNode } from 'react'
import type { TextProps } from 'react-native'
import { openExternalLink } from '../platform/external-link'
import {
  detectFilePathSegments,
  isFilePathCodeSpan,
  normalizeFilePath
} from './markdown-file-path-detection'
import { routeMarkdownHref } from './markdown-href-routing'
import { styles, type MarkdownTone } from './mobile-markdown-styles'
import { MarkdownText } from './mobile-markdown-text'
import { plainText } from './mobile-markdown-tree'

export type MarkdownInlineContext = {
  /** When provided, detected file paths and file-target hrefs render as tappable and invoke
   *  this with the path text; without it, paths render as plain text. */
  onOpenFile?: (pathText: string) => void
  tone: MarkdownTone
  textScale: number
}

type SpanStyle = TextProps['style']

// Web/mail hrefs open the system handler; file-target hrefs (file: URIs and
// scheme-less paths — the entire desktop file-link contract) go to onOpenFile.
export function openMarkdownHref(href: string, onOpenFile?: (pathText: string) => void): void {
  const route = routeMarkdownHref(href)
  if (route.kind === 'web') {
    // The seam, not react-native's `Linking`: this module is in the tasks page closure, and inside
    // the shell's WebView `openURL` resolves without opening anything.
    openExternalLink(route.url)
    return
  }
  if (route.kind === 'file' && onOpenFile) {
    onOpenFile(route.pathText)
  }
}

// A plain text run, with tappable file paths split out when onOpenFile is provided.
function renderTextRun(
  text: string,
  key: string,
  { onOpenFile, tone }: MarkdownInlineContext,
  outer: SpanStyle
): ReactNode {
  if (!onOpenFile) {
    return text
  }
  const segments = detectFilePathSegments(text)
  if (segments.length === 1 && segments[0]!.type === 'text') {
    return text
  }
  return segments.map((segment, segmentIndex) =>
    segment.type === 'file' ? (
      <MarkdownText
        key={`${key}:${segmentIndex}`}
        style={[outer, styles.link, tone.link]}
        onPress={() => onOpenFile(segment.path)}
      >
        {segment.value}
      </MarkdownText>
    ) : (
      <Fragment key={`${key}:${segmentIndex}`}>{segment.value}</Fragment>
    )
  )
}

function renderLink(
  key: string,
  label: string,
  url: string,
  ctx: MarkdownInlineContext,
  outer: SpanStyle
): ReactNode {
  return (
    <MarkdownText
      key={key}
      style={[outer, styles.link, ctx.tone.link]}
      onPress={() => openMarkdownHref(url, ctx.onOpenFile)}
    >
      {label}
    </MarkdownText>
  )
}

function renderPhrasing(
  node: PhrasingContent,
  key: string,
  ctx: MarkdownInlineContext,
  outer: SpanStyle
): ReactNode {
  switch (node.type) {
    case 'text':
      return <Fragment key={key}>{renderTextRun(node.value, key, ctx, outer)}</Fragment>
    case 'break':
      return <Fragment key={key}>{'\n'}</Fragment>
    case 'emphasis':
    case 'strong':
    case 'delete': {
      const emphasis =
        node.type === 'strong'
          ? [styles.bold, ctx.tone.text]
          : node.type === 'emphasis'
            ? styles.italic
            : styles.strike
      const spanStyle = [outer, emphasis]
      return (
        <MarkdownText key={key} style={spanStyle}>
          {renderInline(node.children, ctx, spanStyle, `${key}.`)}
        </MarkdownText>
      )
    }
    case 'inlineCode': {
      // A span keeps its line's leading; only its own smaller size scales.
      const size =
        ctx.textScale !== 1 ? { fontSize: styles.inlineCode.fontSize * ctx.textScale } : null
      return ctx.onOpenFile && isFilePathCodeSpan(node.value) ? (
        <MarkdownText
          key={key}
          style={[
            outer,
            styles.inlineCode,
            size,
            ctx.tone.inlineCode,
            styles.inlineCodeLink,
            ctx.tone.link
          ]}
          onPress={() => ctx.onOpenFile?.(normalizeFilePath(node.value.trim()))}
        >
          {node.value}
        </MarkdownText>
      ) : (
        <MarkdownText key={key} style={[outer, styles.inlineCode, size, ctx.tone.inlineCode]}>
          {node.value}
        </MarkdownText>
      )
    }
    case 'link':
      return renderLink(key, plainText(node), node.url, ctx, outer)
    case 'image':
      return renderLink(key, node.alt || 'image', node.url, ctx, outer)
    case 'footnoteReference':
      return (
        <MarkdownText key={key} style={[outer, styles.footnoteReference, ctx.tone.secondary]}>
          {`[${node.label ?? node.identifier}]`}
        </MarkdownText>
      )
    case 'html':
      return <Fragment key={key}>{node.value}</Fragment>
    // markdown-it resolves references itself, so these only carry their text.
    case 'linkReference':
    case 'imageReference':
      return <Fragment key={key}>{plainText(node)}</Fragment>
  }
}

/** Inline content as spans. iOS range-selectable spans are styled from the root alone, so `outer`
 *  restates the enclosing emphasis on every span inside it. */
export function renderInline(
  nodes: readonly PhrasingContent[],
  ctx: MarkdownInlineContext,
  outer?: SpanStyle,
  keyPrefix = ''
): ReactNode[] {
  return nodes.map((node, index) => renderPhrasing(node, `${keyPrefix}${index}`, ctx, outer))
}
