import type { PhrasingContent } from 'mdast'
import type { Token } from './mobile-markdown-code-nodes'
import { plainText } from './mobile-markdown-plain-text'

// Inline HTML tags desktop's sanitized renderer draws (GitHub's allowlist), as spans. Tags outside it
// keep only their text, as before.
const SPAN_TAGS = new Set([
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
const pairsByTokens = new WeakMap<readonly Token[], Map<number, { tag: string; close: number }>>()

/** Each drawn inline tag's opening token index, with its tag and closing token index. One pass per
 *  inline run, so a run of unclosed tags stays linear. */
export function inlineTagPairs(
  tokens: readonly Token[]
): Map<number, { tag: string; close: number }> {
  const cached = pairsByTokens.get(tokens)
  if (cached) {
    return cached
  }
  const pairs = new Map<number, { tag: string; close: number }>()
  const open: { tag: string; index: number }[] = []
  tokens.forEach((token, index) => {
    const content = token.type === 'html_inline' ? token.content.trim() : ''
    const opened = OPEN_TAG.exec(content)?.[1]?.toLowerCase()
    const closed = CLOSE_TAG.exec(content)?.[1]?.toLowerCase()
    if (opened && SPAN_TAGS.has(opened)) {
      open.push({ tag: opened, index })
      open.splice(0, open.length - MAX_OPEN_TAGS)
    } else if (closed) {
      const at = open.findLastIndex((entry) => entry.tag === closed)
      if (at !== -1) {
        pairs.set(open[at]!.index, { tag: closed, close: index })
        open.length = at
      }
    }
  })
  pairsByTokens.set(tokens, pairs)
  return pairs
}

/** The span a paired tag draws, from the spans between its tags. */
export function inlineTagNode(tag: string, children: PhrasingContent[]): PhrasingContent {
  switch (tag) {
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
