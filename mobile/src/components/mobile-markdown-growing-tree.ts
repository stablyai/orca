import type { Root, RootContent } from 'mdast'
import type { Token } from './mobile-markdown-code-nodes'
import { hasDetailsSectionTag } from './mobile-markdown-details'
import type { MathEnv } from './mobile-markdown-math'
import { markdownTokens, parseMobileMarkdownTree } from './mobile-markdown-tree'

/** One parse's finished blocks, kept for the next parse of the same text grown longer. */
export type MobileMarkdownTreeCache = {
  source: string
  chatMath: boolean
  link: (root: Root) => void
  /** Linked nodes of the blocks before `line`; text added later cannot change them. */
  settled: RootContent[]
  /** The first unfinished line, and where it starts in `source`. */
  line: number
  offset: number
}

const NOTHING_SETTLED = { settled: [], line: 0, offset: 0 }

/** Kinds of top-level block a later line can still join after a blank line. */
const CONTINUES_AFTER_BLANK = new Set(['bullet_list_open', 'ordered_list_open', 'code_block'])

/** The token index where the last finished block ends (0: none yet): before a top-level block that has a blank line above it,
 *  under a block no later line can join, and above the block holding a waiting math opener. Text added later starts no earlier. */
function finishedSplit(tokens: readonly Token[], waitingMathLine = Infinity): number {
  let split = 0
  let above: Token | undefined
  for (const [index, token] of tokens.entries()) {
    if (token.level !== 0 || token.nesting === -1 || !token.map) {
      continue
    }
    if (above?.map && above.map[1] < token.map[0] && !CONTINUES_AFTER_BLANK.has(above.type)) {
      split = index
    }
    if (token.map[1] > waitingMathLine) {
      return split
    }
    above = token
  }
  return split
}

/** The source from `line` on, with its earlier lines left blank so token lines stay the
 *  message's own (code blocks key a reader's choices by line). */
function fromLine(source: string, line: number, offset: number): string {
  return '\n'.repeat(line) + source.slice(offset)
}

/** `parseMobileMarkdownTree` for text that grows by appending, then `link`ed: blocks finished in
 *  an earlier parse keep their nodes, and only the text after them is parsed again. */
export function parseGrowingMobileMarkdownTree(
  previous: MobileMarkdownTreeCache | null,
  source: string,
  growing: boolean,
  chatMath: boolean,
  link: (root: Root) => void
): { root: Root; cache: MobileMarkdownTreeCache | null } {
  const whole = (parsed?: { env: MathEnv; tokens: readonly Token[] }) => {
    const root = parseMobileMarkdownTree(source, growing, chatMath, parsed)
    link(root)
    return { root, cache: null }
  }
  // A lone \r ends a line for markdown-it but not for the line counting here; `<details>` sections span blocks.
  if (source.includes('\r') || hasDetailsSectionTag(source)) {
    return whole()
  }
  const resume =
    previous?.chatMath === chatMath && previous.link === link && source.startsWith(previous.source)
  let { settled, line, offset } = resume ? previous : NOTHING_SETTLED
  const env: MathEnv & { references?: unknown; footnotes?: unknown } = { chatMath }
  const unfinished = fromLine(source, line, offset)
  let tokens = markdownTokens(unfinished, env)
  // Link reference definitions and footnotes reach across blocks; the next parse starts whole.
  if (env.references || env.footnotes) {
    return whole(line === 0 ? { env, tokens } : undefined)
  }
  const split = finishedSplit(tokens, env.waitingMathLine)
  if (split > 0) {
    const finished = parseMobileMarkdownTree(unfinished, false, chatMath, {
      env,
      tokens: tokens.slice(0, split)
    })
    link(finished)
    settled = [...settled, ...finished.children]
    for (const end = tokens[split]!.map![0]; line < end; line += 1) {
      offset = source.indexOf('\n', offset) + 1
    }
    tokens = tokens.slice(split)
  }
  const tail = parseMobileMarkdownTree(fromLine(source, line, offset), growing, chatMath, {
    env,
    tokens
  })
  if (env.references || env.footnotes) {
    return whole()
  }
  link(tail)
  return {
    root: { type: 'root', children: [...settled, ...tail.children] },
    cache: { source, chatMath, link, settled, line, offset }
  }
}
