// Which bots run Tidy-up on ops (the pilot), and the owner's own words an op may cite.
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

/** The owner's own typed words in the chats, one entry per typed line: pasted blocks and quoted
 *  lines are cut out, and evidence must sit inside one entry, never across a cut. */
export function ownerTypedWords(chats: readonly TidyUpChat[]): string[] {
  return chats.flatMap(({ lines }) =>
    lines.flatMap(({ by, text }) =>
      by !== 'owner'
        ? []
        : text
            .replace(PASTED, '\n')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('>'))
    )
  )
}
