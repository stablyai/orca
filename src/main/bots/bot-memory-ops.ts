// Tidy-up as operations: the run sees MEMORY.md as numbered, hashed lines and replies with what to do
// to them, which Orca checks one by one against that snapshot. A bad op is skipped, never the run.
import { createHash } from 'node:crypto'
import * as z from 'zod'
import {
  applyBotMemoryChange,
  type BotMemoryFact,
  type BotMemoryLine,
  botMemoryLineKey,
  parseBotMemoryFacts
} from '../../shared/bot-memory-lines'
import {
  BOT_MEMORY_KIND_WORDS,
  BOT_MEMORY_KINDS,
  type BotMemoryKind,
  hasStandingWords,
  isOwnerKind,
  isProtectedBotMemoryLine
} from '../../shared/bot-memory-line-kinds'
import { redactSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
import { isDerivable } from './bot-memory-line-words'
import { TIDY_UP_ARCHIVE, TIDY_UP_MAX_NEW_FACTS, type TidyUpChat } from './bot-memory-tidy-up'
import { TIDY_UP_TOPIC_NAME, type TidyUpPlan } from './bot-memory-tidy-up-draft'

/** Share of the snapshot's lines that may leave MEMORY.md by retire, replace or merge in one run. */
export const TIDY_UP_OPS_MAX_LOSS = 0.25
const MAX_LINE_CHARS = 240
const MIN_EVIDENCE_CHARS = 8

export type MemorySnapshotLine = {
  /** `L<n>#<hash>`: its number among the facts and a hash of its text, as the run names it. */
  ref: string
  raw: string
  fact: BotMemoryFact
  /** The non-blank line before it, as a change places lines. */
  after: string | null
}

const hashOf = (raw: string): string =>
  createHash('sha256').update(raw.trimEnd()).digest('hex').slice(0, 4)

export function memorySnapshot(memory: string): MemorySnapshotLine[] {
  const lines = memory.split(/\r?\n/)
  const previous = (at: number): string | null =>
    lines.slice(0, at).findLast((line) => line.trim() !== '') ?? null
  return parseBotMemoryFacts(memory).map((fact, index) => {
    const raw = lines[fact.line]
    return { ref: `L${index + 1}#${hashOf(raw)}`, raw, fact, after: previous(fact.line) }
  })
}

export function memorySnapshotText(snapshot: readonly MemorySnapshotLine[]): string {
  return snapshot.map(({ ref, raw }) => `${ref} ${raw.trim()}`).join('\n')
}

const Evidence = z.string().optional()
const OpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    kind: z.enum(BOT_MEMORY_KINDS),
    scope: z.string().optional(),
    text: z.string(),
    evidence: z.string()
  }),
  z.object({ op: z.literal('replace'), line: z.string(), text: z.string(), evidence: Evidence }),
  z.object({
    op: z.literal('merge'),
    lines: z.array(z.string()).min(2).max(8),
    text: z.string(),
    evidence: Evidence
  }),
  z.object({
    op: z.literal('retire'),
    line: z.string(),
    reason: z.enum(['stale', 'done', 'wrong', 'not-a-lesson']),
    evidence: Evidence
  }),
  z.object({
    op: z.literal('demote'),
    lines: z.array(z.string()).optional(),
    range: z.tuple([z.string(), z.string()]).optional(),
    topic: z.string()
  })
])
type Op = z.infer<typeof OpSchema>

/** The reply's one JSON array of ops; null when it has none or it doesn't parse (nothing applies). */
export function parseTidyUpOps(reply: string): unknown[] | null {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start === -1 || end < start) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()
const keyOf = (line: string): string => botMemoryLineKey({ line, after: null }) ?? line.trim()

function kindLine(date: string | null, kind: BotMemoryKind, scope: string | null, text: string) {
  return `- ${date ? `${date} ` : ''}${BOT_MEMORY_KIND_WORDS[kind]}${scope ? ` (${scope})` : ''}: ${text}`
}

/** A kind the evidence itself makes standing ("always", "never", …) needs the owner's Keep. */
function checkedKind(kind: BotMemoryKind, evidence: string): BotMemoryKind {
  return hasStandingWords(evidence) && !isOwnerKind(kind) ? 'rule' : kind
}

export type TidyUpOpsInput = {
  /** What the owner typed in the chats the run read: the only words an op may cite. */
  ownerWords: readonly string[]
  today: string
}

/**
 * What the ops do to MEMORY.md as the run read it, as a Tidy-up plan, and why each skipped op was
 * skipped. Each op names lines by ref; a stale ref, a line an earlier op took, text with new words,
 * an owner line changed without the owner's words, or loss past the limit skips only that op.
 */
export function checkTidyUpOps(
  memory: string,
  ops: readonly unknown[],
  input: TidyUpOpsInput
): { plan: TidyUpPlan; skipped: string[] } {
  const snapshot = memorySnapshot(memory)
  const byRef = new Map(snapshot.map((line) => [line.ref, line]))
  const owner = squash(input.ownerWords.join('\n')).toLowerCase()
  const ownerSaid = (evidence: string | undefined): evidence is string =>
    evidence !== undefined &&
    squash(evidence).length >= MIN_EVIDENCE_CHARS &&
    owner.includes(squash(evidence).toLowerCase())
  const used = new Set<string>()
  const removed: MemorySnapshotLine[] = []
  const added: { line: string; at: MemorySnapshotLine | null }[] = []
  const plan: TidyUpPlan = {
    change: { added: [], removed: [] },
    kept: new Map(),
    topics: new Map(),
    filed: new Set(),
    replaced: new Set(),
    merged: new Set(),
    retired: new Map(),
    learned: new Set(),
    merges: 0
  }
  const skipped: string[] = []
  const lossCap = Math.max(2, Math.ceil(snapshot.length * TIDY_UP_OPS_MAX_LOSS))
  let lost = 0
  const take = (lines: MemorySnapshotLine[]): void => {
    for (const line of lines) {
      used.add(line.ref)
      removed.push(line)
    }
  }
  const apply = (op: Op): string | null => {
    const named = (refs: readonly string[]): MemorySnapshotLine[] | string => {
      const found = refs.flatMap((ref) => byRef.get(ref.trim()) ?? [])
      if (found.length < refs.length) {
        return 'names a line MEMORY.md no longer has'
      }
      return found.some((line) => used.has(line.ref)) ? 'names a line an earlier op took' : found
    }
    if (op.op === 'add') {
      if (plan.learned!.size >= TIDY_UP_MAX_NEW_FACTS) {
        return 'too many new lines'
      }
      const text = squash(op.text)
      if (!ownerSaid(op.evidence)) {
        return "its evidence isn't your owner's words"
      }
      if (text.length > MAX_LINE_CHARS || !isDerivable(text, [op.evidence])) {
        return 'says more than its evidence'
      }
      const kind = checkedKind(op.kind, op.evidence)
      const line = kindLine(input.today, kind, op.scope?.trim() || null, text)
      if (redactSecretLike(line) !== line) {
        return 'looks like a secret'
      }
      added.push({ line, at: null })
      plan.learned!.add(keyOf(line))
      return null
    }
    if (op.op === 'demote') {
      const topic = op.topic.trim()
      if (topic === TIDY_UP_ARCHIVE || !TIDY_UP_TOPIC_NAME.test(topic)) {
        return 'names a topic Orca can’t write'
      }
      let lines: MemorySnapshotLine[]
      if (op.range) {
        const [from, to] = op.range.map((ref) => snapshot.findIndex((line) => line.ref === ref))
        if (from === -1 || to === -1 || to < from) {
          return 'names a range MEMORY.md no longer has'
        }
        // Lines an earlier op took or the owner's own lines are left where they are.
        lines = snapshot
          .slice(from, to + 1)
          .filter((line) => !used.has(line.ref) && !isProtectedBotMemoryLine(line.fact.text))
      } else {
        const found = named(op.lines ?? [])
        if (typeof found === 'string') {
          return found
        }
        if (found.some((line) => isProtectedBotMemoryLine(line.fact.text))) {
          return "moves your owner's rule out of MEMORY.md"
        }
        lines = found
      }
      if (lines.length === 0) {
        return 'moves nothing'
      }
      take(lines)
      const filed = plan.topics.get(topic) ?? []
      plan.topics.set(topic, [...filed, ...lines.map(({ raw }) => raw.trimEnd())])
      lines.forEach(({ raw }) => plan.filed.add(keyOf(raw)))
      return null
    }
    const found = named(op.op === 'merge' ? op.lines : [op.line])
    if (typeof found === 'string') {
      return found
    }
    const owners = found.some((line) => isProtectedBotMemoryLine(line.fact.text))
    if (owners && !ownerSaid(op.evidence)) {
      return "changes your owner's rule without their words"
    }
    // A merge keeps one line of the ones it takes.
    const loss = op.op === 'merge' ? found.length - 1 : 1
    if (lost + loss > lossCap) {
      return 'takes out more lines than one tidy-up may'
    }
    if (op.op === 'retire') {
      take(found)
      plan.retired!.set(keyOf(found[0].raw), op.reason)
      lost += loss
      return null
    }
    const text = squash(op.text)
    const sources = [...found.map(({ fact }) => fact.text), ...(op.evidence ? [op.evidence] : [])]
    if (text === '' || text.length > MAX_LINE_CHARS || !isDerivable(text, sources)) {
      return 'says more than the lines it rewrites'
    }
    const dates = found.flatMap(({ fact }) => fact.date ?? []).toSorted()
    const line = `- ${(op.op === 'merge' ? dates[0] : input.today) ?? input.today} ${text}`
    take(found)
    lost += loss
    added.push({ line, at: found[0] })
    const into = op.op === 'merge' ? plan.merged! : plan.replaced
    found.forEach(({ raw }) => into.add(keyOf(raw)))
    plan.merges! += op.op === 'merge' ? 1 : 0
    return null
  }
  ops.forEach((raw, index) => {
    const parsed = OpSchema.safeParse(raw)
    const why = parsed.success ? apply(parsed.data) : 'is not an op Orca knows'
    if (why) {
      const name = parsed.success ? parsed.data.op : 'op'
      skipped.push(`${name} ${index + 1}: ${why}`)
    }
  })
  plan.change = { added: placed(memory, added, removed), removed: removed.map(changeLine) }
  const next = applyBotMemoryChange(memory, plan.change).split(/\r?\n/)
  plan.kept = new Map(
    next.flatMap((line) => (botMemoryLineKey({ line, after: null }) ? [[keyOf(line), line]] : []))
  )
  return { plan, skipped }
}

const changeLine = ({ raw, after }: MemorySnapshotLine): BotMemoryLine => ({ line: raw, after })

/** Each new line after the nearest line before its place that stays; a learned line above the
 *  first fact. */
function placed(
  memory: string,
  added: readonly { line: string; at: MemorySnapshotLine | null }[],
  removed: readonly MemorySnapshotLine[]
): BotMemoryLine[] {
  const lines = memory.split(/\r?\n/)
  const gone = new Set(removed.map(({ fact }) => fact.line))
  const first = parseBotMemoryFacts(memory)[0]?.line ?? lines.length
  const anchor = (at: number): string | null =>
    lines.slice(0, at).findLast((line, index) => line.trim() !== '' && !gone.has(index)) ?? null
  return added.map(({ line, at }) => ({ line, after: anchor(at ? at.fact.line : first) }))
}

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

/** The owner's own typed words in the chats: their lines without pasted blocks or quoted lines. */
export function ownerTypedWords(chats: readonly TidyUpChat[]): string[] {
  return chats.flatMap(({ lines }) =>
    lines.flatMap(({ by, text }) => {
      if (by !== 'owner') {
        return []
      }
      const typed = text
        .replace(PASTED, '\n')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('>'))
        .join('\n')
        .trim()
      return typed ? [typed] : []
    })
  )
}
