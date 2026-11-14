import type { Literal, PhrasingContent } from 'mdast'
import { splitAtProseUrlTerminators } from '../../shared/prose-url-boundary'
import { httpCandidateNormalizer, type HttpLinkSpan } from './adf-http-link'
import { bareEmailSpans } from './adf-bare-email'
import { escapeMarkdownTextLinkDestination } from './adf-media-destination'
import { adfChildren, adfRecord, adfString } from './adf-nodes'
import { renderInlineMarkdown } from './adf-inline-markdown'

type JiraMarkdownLiteral = Literal & {
  type: 'jiraMedia' | 'jiraAutolink'
  value: string
  url?: string
}
declare module 'mdast' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Module augmentation requires declaration merging.
  interface RootContentMap {
    jiraMedia: JiraMarkdownLiteral
    jiraAutolink: JiraMarkdownLiteral
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Module augmentation requires declaration merging.
  interface PhrasingContentMap {
    jiraMedia: JiraMarkdownLiteral
    jiraAutolink: JiraMarkdownLiteral
  }
}
type Wrapper = Extract<PhrasingContent, { type: 'strong' | 'emphasis' | 'delete' | 'link' }>
type MediaRenderer = (node: Record<string, unknown>) => string
const BARE_HTTP = /https?:\/\/[^\s<>]+|www\.[^\s<>]+/giu

function httpSpans(value: string): HttpLinkSpan[] {
  const spans: HttpLinkSpan[] = []
  let offset = 0
  for (const [pieceIndex, piece] of splitAtProseUrlTerminators(value).entries()) {
    if (pieceIndex % 2 === 0) {
      for (const match of piece.matchAll(BARE_HTTP)) {
        const start = offset + match.index
        const span = httpCandidateNormalizer.normalize(value, start, start + match[0].length)
        if (span) {
          spans.push(span)
        }
      }
    }
    offset += piece.length
  }
  return spans
}

function proseNodes(value: string): PhrasingContent[] {
  const result: PhrasingContent[] = []
  const urls = httpSpans(value)
  const emails = bareEmailSpans(value)
  let urlIndex = 0
  let emailIndex = 0
  let offset = 0
  while (urlIndex < urls.length || emailIndex < emails.length) {
    const url = urls[urlIndex]
    const email = emails[emailIndex]
    const next =
      url && (!email || url.start <= email.start) ? urls[urlIndex++] : emails[emailIndex++]
    if (!next || next.start < offset) {
      continue
    }
    if (next.start > offset) {
      result.push({ type: 'text', value: value.slice(offset, next.start) })
    }
    const label = value.slice(next.start, next.end)
    result.push({ type: 'jiraAutolink', value: label, url: next.url })
    offset = next.end
  }
  if (offset < value.length) {
    result.push({ type: 'text', value: value.slice(offset) })
  }
  return result
}

function appendWrapped(
  target: PhrasingContent[],
  wrappers: Wrapper[],
  children: PhrasingContent[]
): void {
  const [wrapper, ...rest] = wrappers
  if (!wrapper) {
    target.push(...children)
    return
  }
  const last = target.at(-1)
  if (
    last?.type === wrapper.type &&
    'children' in last &&
    (last.type !== 'link' || (wrapper.type === 'link' && last.url === wrapper.url))
  ) {
    appendWrapped(last.children, rest, children)
  } else {
    wrapper.children = []
    appendWrapped(wrapper.children, rest, children)
    target.push(wrapper)
  }
}

export const trailingWhitespaceReader = {
  read: (value: string, index: number): string => value[index]
}

function trailingWhitespaceStart(value: string): number {
  let end = value.length
  while (end > 0 && /^\s$/u.test(trailingWhitespaceReader.read(value, end - 1))) {
    end--
  }
  return end
}

function normalizedStyles(nodes: PhrasingContent[]): PhrasingContent[] {
  const normalized = nodes.flatMap((node): PhrasingContent[] => {
    if (!('children' in node)) {
      return [node]
    }
    node.children = normalizedStyles(node.children)
    if (!['strong', 'emphasis', 'delete'].includes(node.type)) {
      return [node]
    }
    const first = node.children[0]
    const last = node.children.at(-1)
    const leading = first?.type === 'text' ? (/^\s+/.exec(first.value)?.[0] ?? '') : ''
    if (first?.type === 'text') {
      first.value = first.value.slice(leading.length)
    }
    const trailing =
      last?.type === 'text' ? last.value.slice(trailingWhitespaceStart(last.value)) : ''
    if (last?.type === 'text' && trailing) {
      last.value = last.value.slice(0, -trailing.length)
    }
    node.children = node.children.filter((child) => child.type !== 'text' || child.value !== '')
    return [
      ...(leading ? [{ type: 'text' as const, value: leading }] : []),
      ...(node.children.length ? [node] : []),
      ...(trailing ? [{ type: 'text' as const, value: trailing }] : [])
    ]
  })
  const result: PhrasingContent[] = []
  for (const node of normalized) {
    const previous = result.at(-1)
    if (node.type === 'text' && previous?.type === 'text') {
      previous.value += node.value
    } else {
      result.push(node)
    }
  }
  return result
}

export function adfInlineNodes(
  value: unknown,
  renderMedia: MediaRenderer,
  inTable = false
): PhrasingContent[] {
  const result: PhrasingContent[] = []
  for (const child of adfChildren(value)) {
    const node = adfRecord(child)
    if (typeof node.text === 'string') {
      const marks = adfChildren(node.marks).map(adfRecord)
      const types = new Set(marks.map((mark) => mark.type))
      const link = marks.find((mark) => mark.type === 'link')
      const url = escapeMarkdownTextLinkDestination(adfString(adfRecord(link?.attrs).href))
      const wrappers: Wrapper[] = []
      if (!types.has('code')) {
        if (types.has('strong')) {
          wrappers.push({ type: 'strong', children: [] })
        }
        if (types.has('em')) {
          wrappers.push({ type: 'emphasis', children: [] })
        }
        if (types.has('strike')) {
          wrappers.push({ type: 'delete', children: [] })
        }
      }
      if (url) {
        wrappers.push({ type: 'link', url, children: [] })
      }
      const content: PhrasingContent[] = types.has('code')
        ? [{ type: 'inlineCode', value: node.text }]
        : url
          ? [{ type: 'text', value: node.text }]
          : proseNodes(node.text)
      appendWrapped(result, wrappers, content)
    } else if (node.type === 'hardBreak') {
      result.push(inTable ? { type: 'html', value: '<br>' } : { type: 'break' })
    } else if (node.type === 'media' || node.type === 'mediaInline') {
      result.push({ type: 'jiraMedia', value: renderMedia(node) })
    } else {
      const attrs = adfRecord(node.attrs)
      const text = adfString(attrs.text) || adfString(attrs.shortName) || adfString(attrs.url)
      result.push(...(text ? proseNodes(text) : adfInlineNodes(node.content, renderMedia, inTable)))
    }
  }
  return normalizedStyles(result)
}

export function renderAdfInline(
  value: unknown,
  renderMedia: MediaRenderer,
  inTable = false,
  heading = false
): string {
  return renderInlineMarkdown(adfInlineNodes(value, renderMedia, inTable), inTable, heading)
}
