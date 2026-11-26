import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { BOT_GROUP_CONTEXT_MAX, fitBotGroupContext } from '../../shared/bots/bot-group'
// GFM, as replies render: table cells end inline code at a pipe.
const markdown = unified().use(remarkParse).use(remarkGfm)

/** `reply` with its Markdown code (fenced, indented, inline) and block quotes blanked in place,
 *  lines and offsets kept; text with no `@` has nothing to blank. */
export function blankMarkdownCode(reply: string): string {
  if (!reply.includes('@')) {
    return reply
  }
  const ranges: [number, number][] = []
  const pending: Nodes[] = [markdown.parse(reply)]
  for (let node = pending.pop(); node; node = pending.pop()) {
    const { start, end } = node.position ?? {}
    const masked = node.type === 'code' || node.type === 'inlineCode' || node.type === 'blockquote'
    if (masked && start?.offset !== undefined && end?.offset !== undefined) {
      ranges.push([start.offset, end.offset])
    } else if ('children' in node) {
      for (const child of node.children) {
        pending.push(child)
      }
    }
  }
  // Masked nodes never nest (their children are not walked), so one pass in source order builds it.
  const parts: string[] = []
  let cursor = 0
  for (const [start, end] of ranges.toSorted((left, right) => left[0] - right[0])) {
    // One space per UTF-16 unit, so masked offsets index the original reply.
    const blank = reply
      .slice(start, end)
      .split('\n')
      .map((line) => ' '.repeat(line.length))
      .join('\n')
    parts.push(reply.slice(cursor, start), blank)
    cursor = end
  }
  parts.push(reply.slice(cursor))
  return parts.join('')
}

/** A finished member turn's reply: whole, as mentions read it, and as saved for room history. */
export type GroupMemberReply = { full: string; saved: string }

/** Around a mention past the saved tail of a long reply: what a woken member is asked to do. */
const EXCERPT_BEFORE = 1_000
const EXCERPT_AFTER = 3_000

export function namingExcerpt(text: string, at: number): string {
  return excerpt(text, at, EXCERPT_BEFORE, EXCERPT_AFTER)
}

/** `context` (the quoted history lines) holding the speaker's reply where it names this member: the
 *  saved reply when the mention is in it, else an excerpt around the mention, cut further around
 *  the mention until it alone fits the room-history budget. That line is kept and older lines go
 *  first to fit the rest. */
export function withNamingReply(
  context: string,
  speaker: { id: string; name: string },
  reply: GroupMemberReply,
  mention: { start: number; end: number }
): string {
  const lines: unknown[] = JSON.parse(context)
  const author = { kind: 'bot', ...speaker }
  const savedFrom = reply.full.length - reply.saved.length
  const inSaved = mention.start >= savedFrom
  const source = inSaved ? reply.saved : reply.full
  const offset = inSaved ? savedFrom : 0
  const start = mention.start - offset
  const end = mention.end - offset
  let before = inSaved ? start : EXCERPT_BEFORE
  let after = inSaved ? source.length - end : EXCERPT_AFTER
  let text = excerpt(source, start, before, end - start + after)
  while (JSON.stringify([{ author, text }]).length > BOT_GROUP_CONTEXT_MAX) {
    before = Math.floor(before / 2)
    after = Math.floor(after / 2)
    text = excerpt(source, start, before, end - start + after)
  }
  const index = lines.findIndex(
    (line) =>
      typeof line === 'object' &&
      line !== null &&
      'text' in line &&
      line.text === text &&
      'author' in line &&
      JSON.stringify(line.author) === JSON.stringify(author)
  )
  return index === -1
    ? fitBotGroupContext([...lines, { author, text }], 1)
    : fitBotGroupContext(lines, lines.length - index)
}

/** `source` from `before` units ahead of `at` to `after` units past it, marked where cut. */
function excerpt(source: string, at: number, before: number, after: number): string {
  const from = Math.max(0, at - before)
  const to = Math.min(source.length, at + after)
  return `${from > 0 ? '…' : ''}${source.slice(from, to)}${to < source.length ? '…' : ''}`
}
