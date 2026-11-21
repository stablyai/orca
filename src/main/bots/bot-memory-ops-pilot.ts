// Which bots run Tidy-up on ops (the pilot), and the owner's own typed words an added line must
// repeat: one physical line at a time, with pasted blocks and quoted lines cut out.
import { parseBotMemoryFacts } from '../../shared/bot-memory-lines'
import type { TidyUpChat } from './bot-memory-tidy-up'

/** A bot's Tidy-up runs on ops only while this file is in its home (the pilot). */
export const TIDY_UP_OPS_PILOT_FILE = '.orca-memory-pilot'
/** Lines past this many that aren't facts (headings aside) keep a bot on whole-file Tidy-up: the
 *  snapshot would leave them out of every op and every limit. */
export const TIDY_UP_OPS_MAX_PROSE_LINES = 5

export function memoryFitsOps(memory: string): boolean {
  const facts = new Set(parseBotMemoryFacts(memory).map(({ line }) => line))
  const prose = memory
    .split(/\r?\n/)
    .filter((line, index) => line.trim() !== '' && !line.startsWith('#') && !facts.has(index))
  return prose.length <= TIDY_UP_OPS_MAX_PROSE_LINES
}

const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/g
/** Stands where a pasted block was, inside its line, so a quoted line stays quoted around it. */
const CUT = '⁣'

/** One owner message's typed segments: its physical lines, each split where a paste was cut, with
 *  quoted lines (">", judged before the cut) left out. */
export function ownerTypedSegments(text: string): string[] {
  return text
    .replace(PASTED, CUT)
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .flatMap((line) => line.split(CUT))
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => segment !== '')
}

/** The owner's own typed words in the chats, one entry per segment. */
export function ownerTypedWords(chats: readonly TidyUpChat[]): string[] {
  return chats.flatMap(({ lines }) =>
    lines.flatMap(({ by, text }) => (by === 'owner' ? ownerTypedSegments(text) : []))
  )
}

const NEGATING =
  /\b(?:not|no|never|don['’]?t|doesn['’]?t|isn['’]?t|can['’]?t|cannot|won['’]?t|without|neither|nor)\b/i
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether `text` is a whole clause the owner typed, word for word: it starts where a segment or a
 * clause starts and ends where one ends, and nothing negating comes before it in its sentence, so
 * "deploy staging" can't be cut from "Do not deploy staging" or "Don't, ever, deploy staging".
 */
export function isOwnerClause(text: string, segments: readonly string[]): boolean {
  const wanted = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?;:,]+$/, '')
  if (wanted.length < 12) {
    return false
  }
  const clause = new RegExp(
    `(^|[.;:!?,\\u2013\\u2014(]\\s*)${escape(wanted)}\\s*(?=$|[.;:!?,\\u2013\\u2014)])`,
    'gi'
  )
  return segments.some((segment) =>
    [...segment.matchAll(clause)].some((match) => {
      const before = segment.slice(0, match.index + match[1].length)
      const sentence = before.split(/[.;!?]/).at(-1) ?? ''
      return !NEGATING.test(sentence)
    })
  )
}
