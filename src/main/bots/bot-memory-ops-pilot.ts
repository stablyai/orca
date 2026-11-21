// Which bots run Tidy-up on ops (the pilot), and the owner's own typed words a turn end reads:
// one physical line at a time, with pasted blocks and quoted lines cut out.
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
const CUT = '\u2063'

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

/** The owner's own typed words in the chats: each message's segments. */
export function ownerTypedWords(chats: readonly TidyUpChat[]): string[][] {
  return chats.flatMap(({ lines }) =>
    lines.flatMap(({ by, text }) => {
      const segments = by === 'owner' ? ownerTypedSegments(text) : []
      return segments.length > 0 ? [segments] : []
    })
  )
}
