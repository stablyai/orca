import type { PhrasingContent } from 'mdast'
import type { Token } from './mobile-markdown-code-nodes'
import { plainText } from './mobile-markdown-plain-text'

// Inline HTML tags desktop's sanitized renderer draws (GitHub's allowlist), as spans. Tags outside it
// keep only their text, as before.
const SPAN_TAGS = new Set([
  'a',
  'b',
  'strong',
  'i',
  'em',
  'del',
  's',
  'strike',
  'code',
  'sub',
  'sup',
  'kbd',
  'ins'
])
const OPEN_TAG = /^<([a-z]+)(?:\s[^<>]*)?>$/i

const CLOSE_TAG = /^<\/([a-z]+)\s*>$/i
/** How far back a closing tag looks for its opener; unclosed tags beyond that stay text. */
const MAX_OPEN_TAGS = 32
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i

type TagPair = { tag: string; close: number; href: string }
const pairsByTokens = new WeakMap<readonly Token[], Map<number, TagPair>>()

/** Each drawn inline tag's opening token index, with its tag and closing token index. One pass per
 *  inline run, so a run of unclosed tags stays linear. */
export function inlineTagPairs(tokens: readonly Token[]): Map<number, TagPair> {
  const cached = pairsByTokens.get(tokens)
  if (cached) {
    return cached
  }
  const pairs = new Map<number, TagPair>()
  const open: { tag: string; index: number; href: string }[] = []
  tokens.forEach((token, index) => {
    const content = token.type === 'html_inline' ? token.content.trim() : ''
    const opened = OPEN_TAG.exec(content)?.[1]?.toLowerCase()
    const closed = CLOSE_TAG.exec(content)?.[1]?.toLowerCase()
    if (opened && SPAN_TAGS.has(opened)) {
      const href = HREF.exec(content)
      open.push({ tag: opened, index, href: href?.[1] ?? href?.[2] ?? href?.[3] ?? '' })
      open.splice(0, open.length - MAX_OPEN_TAGS)
    } else if (closed) {
      const at = open.findLastIndex((entry) => entry.tag === closed)
      if (at !== -1) {
        pairs.set(open[at]!.index, { tag: closed, close: index, href: open[at]!.href })
        open.length = at
      }
    }
  })
  pairsByTokens.set(tokens, pairs)
  return pairs
}

/** The span a paired tag draws, from the spans between its tags. */
export function inlineTagNode(
  { tag, href }: Pick<TagPair, 'tag' | 'href'>,
  children: PhrasingContent[]
): PhrasingContent {
  switch (tag) {
    case 'a':
      // An anchor without an href (a named target) keeps only its text.
      return href
        ? { type: 'link', url: href, children }
        : { type: 'htmlSpan', tag: 'span', children }
    case 'b':
    case 'strong':
      return { type: 'strong', children }
    case 'i':
    case 'em':
      return { type: 'emphasis', children }
    case 'del':
    case 's':
    case 'strike':
      return { type: 'delete', children }
    case 'code':
      return { type: 'inlineCode', value: children.map(plainText).join('') }
    default:
      return { type: 'htmlSpan', tag, children }
  }
}
