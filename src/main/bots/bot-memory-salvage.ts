// Salvage: owner decisions the status move took out of MEMORY.md, offered back word for word. No
// model reads or writes them: fixed patterns pick the candidates, a later journal line on the same
// work only adds a note to one, and the owner's answer is read by its exact forms alone.
import { createHash } from 'node:crypto'
import { parseBotMemoryFacts } from '../../shared/bot-memory-lines'
import { keyWords, wordSimilarity } from './bot-memory-line-words'

const DAY_MS = 86_400_000

export const SALVAGE = {
  /** Candidates one proposal lists; "all" restores every one listed. */
  perProposal: 20,
  everyMs: 7 * DAY_MS,
  expiresMs: 14 * DAY_MS,
  /** A candidate no answer came for this many times is settled as expired. */
  expiriesFinal: 2,
  /** The longest line a restore writes, as any memory add allows. */
  lineChars: 240,
  /** Key-word overlap at which a later line is named as possibly replacing a candidate. */
  overlap: 0.5
} as const

/** A moved line's identity: its journal month and its words as moved. A line reworded since is a
 *  new line, never this one. */
export function salvageLineHash(month: string, line: string): string {
  return createHash('sha256').update(`${month}\n${line.trimEnd()}`).digest('hex')
}

/** What the owner deciding sounds like. Wide on purpose: a line that matches stays in MEMORY.md,
 *  so a false match only costs its bytes, while a miss moves a decision out. */
const VERBS = [
  'pick(?:s|ed)?',
  'decid(?:e|es|ed)',
  'chose|chos(?:e|en)|choos(?:e|es)',
  'prefer(?:s|red)?',
  'approv(?:e|es|ed)',
  "okayed|ok'd",
  'reject(?:s|ed)?',
  'declin(?:e|es|ed)',
  'agree(?:s|d)?',
  'confirm(?:s|ed)?',
  'rul(?:e|es|ed)',
  'want(?:s|ed)?',
  'said|says',
  'told|tells?',
  'ask(?:s|ed)?',
  'sign(?:s|ed)? off',
  'go(?:es)? with|went with'
]
/** Not inside a word: a name or verb counts only as a whole word ("co-owner" is not "owner"). */
const EDGE = '\\p{L}\\p{N}_-'
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const word = (pattern: string): string => `(?<![${EDGE}])(?:${pattern})(?![${EDGE}])`

/**
 * Whether a line reads as the owner deciding, so the status move leaves it in MEMORY.md:
 * - the owner named ("owner" or one of `ownerNames`), then a decision verb in the same clause
 *   within 20 characters ("Dana picked", "owner decided to");
 * - a decision verb, then "by" or "from" the owner ("approved by Dana", "go-ahead from owner"),
 *   or "per" the owner;
 * - the owner's words after a colon ("Dana: CSV first"), "Dana's call" or "owner's decision", or an
 *   owner rule stated ("owner rule: ...").
 * "decided" with no owner named is anyone's, so never enough; "code owner" is a role.
 */
export function salvageCandidateTest(ownerNames: readonly string[]): (text: string) => boolean {
  const names = ['owner', ...ownerNames.map((name) => name.trim()).filter(Boolean)]
  const who = `(?<!code )${word(names.map(escaped).join('|'))}`
  const verb = word(VERBS.join('|'))
  // The words between stay in one clause: no stop, semicolon, comma, colon or "|", so "asked Dana,
  // reviewer picked" is the reviewer's.
  const gap = '[^.;,:|\\n]{0,20}?'
  const tests = [
    new RegExp(`${who}${gap}${verb}`, 'iu'),
    new RegExp(
      `(?:${verb}|${word('go-ahead|ok|sign-off')})\\s+(?:by|from)\\s+(?:the\\s+)?${who}`,
      'iu'
    ),
    new RegExp(`${word('per')}\\s+(?:the\\s+)?${who}`, 'iu'),
    // The owner's own words after a colon, quoted or not ("Dana: CSV first").
    new RegExp(`${who}\\s*:\\s*\\S`, 'iu'),
    // "Dana's call", "owner's decision".
    new RegExp(`${who}['\\u2019]s\\s+(?:call|decision|pick|choice|rule|preference)`, 'iu'),
    // A rule stated, not one merely mentioned ("no owner rule yet").
    /\bowner rule\s*:/i
  ]
  return (text) => tests.some((test) => test.test(text))
}

const REVERSAL = /\b(?:reverted|dropped|no longer|instead|canceled|cancelled|superseded)\b/i
const REF = /#\d{2,6}\b|\bitem\s+#?\d{2,5}\b|\b(?:ctx|dispatch)_[0-9a-z]{6,}\b/gi

function refsOf(text: string): Set<string> {
  return new Set(
    (text.match(REF) ?? []).map((ref) => ref.toLowerCase().replace(/^item\s+#?/, 'item '))
  )
}

export type SalvageJournalLine = { line: string; date: string | null }

/**
 * The later journal line that may replace a candidate, for its note; null when none. Later means a
 * date after the candidate's own, so a line the same day never counts. A line qualifies when it
 * names the same PR, item or worker with a word of reversal, or shares half its key words. It only
 * adds a note: the owner still decides.
 */
export function salvageSupersededBy(
  candidate: SalvageJournalLine,
  journal: readonly SalvageJournalLine[]
): string | null {
  if (!candidate.date) {
    return null
  }
  const refs = refsOf(candidate.line)
  const words = keyWords(factText(candidate.line))
  const later = journal
    .filter(({ date, line }) => date !== null && date > candidate.date! && line !== candidate.line)
    .toSorted((a, b) => a.date!.localeCompare(b.date!))
  // The latest that qualifies, so a chain of reversals names where it ended.
  const hit = later.findLast(
    ({ line }) =>
      (REVERSAL.test(line) && [...refsOf(line)].some((ref) => refs.has(ref))) ||
      wordSimilarity(words, keyWords(factText(line))) >= SALVAGE.overlap
  )
  return hit?.line ?? null
}

function factText(line: string): string {
  return parseBotMemoryFacts(line)[0]?.text ?? line.trim()
}

/** A line's date, when it opens with one. */
export function salvageLineDate(line: string): string | null {
  return parseBotMemoryFacts(line)[0]?.date ?? null
}

const NUMBERS = /^\d+(?:(?:\s*,\s*|\s+and\s+|\s+)\d+)*$/

/**
 * The numbers an owner's answer keeps, of `count` listed; null when it isn't one of the exact
 * forms, which restores nothing. The whole comment is read: "all" or "keep all", "none" or "keep
 * none", or numbers apart by commas, spaces or "and". Anything else, a number outside 1..count
 * included, is unreadable, so "keep all except 3" never keeps all.
 */
export function parseSalvageAnswer(text: string, count: number): number[] | null {
  const answer = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (answer === 'all' || answer === 'keep all') {
    return Array.from({ length: count }, (_, index) => index + 1)
  }
  if (answer === 'none' || answer === 'keep none') {
    return []
  }
  if (!NUMBERS.test(answer)) {
    return null
  }
  const numbers = (answer.match(/\d+/g) ?? []).map(Number)
  if (numbers.some((number) => number < 1 || number > count)) {
    return null
  }
  return [...new Set(numbers)].toSorted((a, b) => a - b)
}
