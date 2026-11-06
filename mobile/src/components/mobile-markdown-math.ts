import type MarkdownIt from 'markdown-it'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import {
  isCitationBracketMath,
  isDisplayMathOpener,
  markdownMathCloser,
  endsDollarAmount,
  rejectsSingleDollarClose,
  rejectsSingleDollarOpen
} from '../../../src/shared/markdown-math-rules'

// Desktop chat's math grammar (src/renderer/src/components/sidebar/chat-markdown-math.ts) for markdown-it.

/** Where each delimiter sits in one inline source, so every opener's search is a lookup. */
type InlineMathIndex = {
  escaped: Uint8Array
  /** Start of each unescaped `$` run, keyed by run length. */
  dollarRuns: Map<number, number[]>
  /** Start of every unescaped `$` run, whatever its length: a single `$` closes at the first. */
  dollarStarts: number[]
  /** Unescaped `\` starting `\)` or `\]`, keyed by the closer. */
  closers: Map<string, number[]>
  newlines: number[]
  backticks: number[]
}

const inlineIndexes = new WeakMap<StateInline, InlineMathIndex>()

/** Where the run of `$` starting at `at` ends. */
function dollarRunEnd(text: string, at: number): number {
  let end = at
  while (text[end] === '$') {
    end += 1
  }
  return end
}

/** `escaped[i]`: an odd backslash run sits right before character i. */
function escapedCharacters(text: string): Uint8Array {
  const escaped = new Uint8Array(text.length + 1)
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\' && !escaped[index]) {
      escaped[index + 1] = 1
    }
  }
  return escaped
}

function pushKeyed<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key)
  if (list) {
    list.push(value)
  } else {
    map.set(key, [value])
  }
}

function indexInlineSource(src: string): InlineMathIndex {
  const escaped = escapedCharacters(src)
  const index: InlineMathIndex = {
    escaped,
    dollarRuns: new Map(),
    dollarStarts: [],
    closers: new Map(),
    newlines: [],
    backticks: []
  }
  for (let at = 0; at < src.length; at += 1) {
    const char = src[at]
    if (char === '$' && !escaped[at]) {
      const end = dollarRunEnd(src, at)
      pushKeyed(index.dollarRuns, end - at, at)
      index.dollarStarts.push(at)
      at = end - 1
    } else if (char === '\\' && !escaped[at] && (src[at + 1] === ')' || src[at + 1] === ']')) {
      pushKeyed(index.closers, `\\${src[at + 1]}`, at)
    } else if (char === '\n') {
      index.newlines.push(at)
    } else if (char === '`') {
      index.backticks.push(at)
    }
  }
  return index
}

/** The first entry at or after `from`, or Infinity. */
function nextAtOrAfter(sorted: readonly number[] | undefined, from: number): number {
  if (!sorted) {
    return Infinity
  }
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! < from) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return sorted[low] ?? Infinity
}

/** Chat reads `\(…\)` and `\[…\]` as math too, like desktop chat; GitHub text reads `$` only, so
 *  an escaped bracket there (`\[Bug\]`) stays a bracket. */
function chatDelimiters(env: unknown): boolean {
  return typeof env === 'object' && env !== null && 'chatMath' in env && env.chatMath === true
}

function openerAt(src: string, at: number, brackets: boolean): string | null {
  if (src[at] === '\\') {
    return brackets && (src[at + 1] === '(' || src[at + 1] === '[') ? src.slice(at, at + 2) : null
  }
  const end = dollarRunEnd(src, at)
  return end > at ? src.slice(at, end) : null
}

/** `$` then a number that ends there (`$5 or`, `$10;`) is a price, not an opener. */
function isDollarAmount(src: string, bodyStart: number): boolean {
  if (!/[0-9]/.test(src[bodyStart] ?? '')) {
    return false
  }
  let end = bodyStart
  while (/[0-9.,]/.test(src[end] ?? '')) {
    end += 1
  }
  return endsDollarAmount(src[end])
}

function inlineMath(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state
  const brackets = chatDelimiters(state.env)
  if (src[pos] !== '$' && !(brackets && src[pos] === '\\')) {
    return false
  }
  let index = inlineIndexes.get(state)
  if (!index) {
    index = indexInlineSource(src)
    inlineIndexes.set(state, index)
  }
  // A `$` run is one opener: its tail never reopens after the whole run failed, and is not rescanned.
  if (src[pos] === '$' && src[pos - 1] === '$' && !index.escaped[pos - 1]) {
    return false
  }
  const opener = openerAt(src, pos, brackets)
  if (!opener) {
    return false
  }
  const bodyStart = pos + opener.length
  if (
    opener === '$' &&
    (rejectsSingleDollarOpen(src[bodyStart]) || isDollarAmount(src, bodyStart))
  ) {
    return false
  }
  const closer = markdownMathCloser(opener)
  const close =
    opener === '$'
      ? nextAtOrAfter(index.dollarStarts, bodyStart)
      : opener[0] === '$'
        ? nextAtOrAfter(index.dollarRuns.get(opener.length), bodyStart)
        : nextAtOrAfter(index.closers.get(closer), bodyStart)
  const stop = Math.min(
    nextAtOrAfter(index.backticks, bodyStart),
    opener === '\\(' ? nextAtOrAfter(index.newlines, bodyStart) : Infinity
  )
  if (close >= stop || close + closer.length > state.posMax) {
    return false
  }
  const body = src.slice(bodyStart, close)
  if (
    (opener === '$' && rejectsSingleDollarClose(src[close - 1], src[close + 1])) ||
    isCitationBracketMath(opener, body)
  ) {
    return false
  }
  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.content = body
    token.markup = opener
  }
  state.pos = close + closer.length
  return true
}

/** The closer's offset in one line of a block, honouring backslash escapes, or -1. */
function closerInLine(text: string, opener: string): number {
  const escaped = escapedCharacters(text)
  for (let at = 0; at < text.length; at += 1) {
    if (escaped[at]) {
      continue
    }
    if (opener[0] === '$' && text[at] === '$') {
      const end = dollarRunEnd(text, at)
      if (end - at === opener.length) {
        return at
      }
      at = end - 1
    } else if (opener === '\\[' && text.startsWith('\\]', at)) {
      return at
    }
  }
  return -1
}

/** Block scans that failed, per parse, by the lines they read. A later opener of the same kind inside
 *  that range reads the same lines to the same end, so it fails without rescanning (paragraphs retry
 *  every line). Containers look ahead, so a range never rejects an opener before it. */
const failedBlockScans = new WeakMap<StateBlock, Map<string, { from: number; to: number }>>()

function blockMath(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) {
    return false
  }
  const { src } = state
  const start = state.bMarks[startLine]! + state.tShift[startLine]!
  const opener = openerAt(src, start, chatDelimiters(state.env))
  // Single `$` and `\(` never open a block.
  if (!opener || !isDisplayMathOpener(opener)) {
    return false
  }
  let failed = failedBlockScans.get(state)
  if (!failed) {
    failed = new Map()
    failedBlockScans.set(state, failed)
  }
  const scan = `${opener}:${state.blkIndent}:${endLine}`
  const searched = failed.get(scan)
  if (searched && startLine > searched.from && startLine < searched.to) {
    return false
  }
  const closer = markdownMathCloser(opener)
  const lines: string[] = []
  let closed = false
  let line = startLine
  let from = start + opener.length
  while (line < endLine) {
    const text = src.slice(from, state.eMarks[line])
    const at = closerInLine(text, opener)
    if (at >= 0) {
      // A closer with text after it is inline math in a paragraph, not a block.
      if (text.slice(at + closer.length).trim()) {
        failed.set(scan, { from: startLine, to: line })
        return false
      }
      lines.push(text.slice(0, at))
      closed = true
      break
    }
    lines.push(text)
    line += 1
    from = state.bMarks[line]! + state.tShift[line]!
    // Like a fence, the block ends where its list item or quote does.
    if (line < endLine && from < state.eMarks[line]! && state.sCount[line]! < state.blkIndent) {
      break
    }
  }
  const body = lines.join('\n')
  // An unclosed block is chat still streaming in; GitHub keeps an unclosed `$$` as text.
  if (isCitationBracketMath(opener, body) || (!closed && !chatDelimiters(state.env))) {
    failed.set(scan, { from: startLine, to: line })
    return false
  }
  if (silent) {
    return true
  }
  const next = closed ? line + 1 : line
  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = body
  token.markup = opener
  token.map = [startLine, next]
  // A block with no closer is still streaming in.
  token.meta = { closed }
  state.line = next
  return true
}

/** `$…$` and `$$…$$` (plus `\(…\)` and `\[…\]` when parsed with `{ chatMath: true }`), by desktop
 *  chat's rules. */
export function mobileMarkdownMath(markdown: MarkdownIt): void {
  markdown.inline.ruler.before('escape', 'math_inline', inlineMath)
  markdown.block.ruler.before('fence', 'math_block', blockMath, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })
}
