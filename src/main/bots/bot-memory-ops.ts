// Tidy-up as operations: the run sees MEMORY.md as numbered, hashed lines and replies with what to do
// to them, which Orca checks one by one against that snapshot. A bad op is skipped, never the run.
import { createHash } from 'node:crypto'
import * as z from 'zod'
import {
  type BotMemoryFact,
  type BotMemoryLine,
  botMemoryLineKey,
  parseBotMemoryFacts
} from '../../shared/bot-memory-lines'
import { botMemoryLineKind, isProtectedBotMemoryLine } from '../../shared/bot-memory-line-kinds'
import { redactSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
import { hasMeaningWords, isDerivable } from './bot-memory-line-words'
import { TIDY_UP_ARCHIVE } from './bot-memory-tidy-up'
import { TIDY_UP_TOPIC_NAME, type TidyUpPlan } from './bot-memory-tidy-up-draft'

/** Share of the snapshot's lines that may leave MEMORY.md by retire, replace or merge in one run. */
export const TIDY_UP_OPS_MAX_LOSS = 0.25
const MAX_LINE_CHARS = 240

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
  // The non-blank line before each line, in one pass.
  const previous: (string | null)[] = []
  let last: string | null = null
  for (const line of lines) {
    previous.push(last)
    last = line.trim() === '' ? last : line
  }
  return parseBotMemoryFacts(memory).map((fact, index) => {
    const raw = lines[fact.line]
    return { ref: `L${index + 1}#${hashOf(raw)}`, raw, fact, after: previous[fact.line] ?? null }
  })
}

export function memorySnapshotText(snapshot: readonly MemorySnapshotLine[]): string {
  return snapshot.map(({ ref, raw }) => `${ref} ${raw.trim()}`).join('\n')
}

const Evidence = z.string().optional()
const OpSchema = z.discriminatedUnion('op', [
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

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()
const keyOf = (line: string): string => botMemoryLineKey({ line, after: null }) ?? line.trim()

export type TidyUpOpsInput = { today: string }

/**
 * What the ops do to MEMORY.md as the run read it, as a Tidy-up plan, and why each skipped op was
 * skipped. Owner rules and undated lines, and every copy of them, are never touched: the owner
 * edits those. A line with a negation or modal is never rewritten, only moved or left. No op adds
 * a line: new lines come from the owner and the bot's own turns. Lines leave with every copy.
 */
export function checkTidyUpOps(
  memory: string,
  ops: readonly unknown[],
  input: TidyUpOpsInput
): { plan: TidyUpPlan; skipped: string[] } {
  const snapshot = memorySnapshot(memory)
  const byRef = new Map(snapshot.map((line) => [line.ref, line]))
  const groups = new Map<string, MemorySnapshotLine[]>()
  for (const line of snapshot) {
    const group = groups.get(keyOf(line.raw))
    if (group) {
      group.push(line)
    } else {
      groups.set(keyOf(line.raw), [line])
    }
  }
  const groupOf = (line: MemorySnapshotLine): MemorySnapshotLine[] =>
    groups.get(keyOf(line.raw)) ?? [line]
  const guarded = (line: MemorySnapshotLine): boolean =>
    line.fact.date === null || isProtectedBotMemoryLine(line.fact.text)
  const fixed = (line: MemorySnapshotLine): boolean => groupOf(line).some(guarded)
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
  const lossCap = Math.max(1, Math.floor(snapshot.length * TIDY_UP_OPS_MAX_LOSS))
  let lost = 0
  const take = (lines: MemorySnapshotLine[]): void => {
    for (const line of lines) {
      used.add(line.ref)
      removed.push(line)
    }
  }
  const existing = (line: string): boolean => groups.has(keyOf(line))
  const apply = (op: Op): string | null => {
    const named = (refs: readonly string[]): MemorySnapshotLine[] | string => {
      const unique = [...new Set(refs.map((ref) => ref.trim()))]
      const picked = unique.flatMap((ref) => byRef.get(ref) ?? [])
      if (unique.length < refs.length) {
        return 'names a line twice'
      }
      if (picked.length < unique.length) {
        return 'names a line MEMORY.md no longer has'
      }
      const found = [...new Set(picked.flatMap(groupOf))]
      if (found.some((line) => used.has(line.ref))) {
        return 'names a line an earlier op took'
      }
      return found.some(fixed)
        ? "names your owner's rule or an undated line, which only your owner changes"
        : found
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
        // Lines an earlier op took and the owner's own lines stay where they are.
        const inRange = snapshot.slice(from, to + 1).filter((line) => !fixed(line))
        lines = [...new Set(inRange.flatMap(groupOf))].filter((line) => !used.has(line.ref))
      } else {
        const found = named(op.lines ?? [])
        if (typeof found === 'string') {
          return found
        }
        lines = found
      }
      if (lines.length === 0) {
        return 'moves nothing'
      }
      take(lines)
      plan.topics.set(topic, [
        ...(plan.topics.get(topic) ?? []),
        ...lines.map(({ raw }) => raw.trimEnd())
      ])
      lines.forEach(({ raw }) => plan.filed.add(keyOf(raw)))
      return null
    }
    const found = named(op.op === 'merge' ? op.lines : [op.line])
    if (typeof found === 'string') {
      return found
    }
    const distinct = new Set(found.map(({ raw }) => keyOf(raw))).size
    if (op.op === 'merge' && distinct < 2) {
      return 'merges fewer than two different lines'
    }
    // Every copy taken counts; a merge keeps one line for its lines.
    const loss = op.op === 'merge' ? found.length - 1 : found.length
    if (lost + loss > lossCap) {
      return 'takes out more lines than one tidy-up may'
    }
    if (op.op === 'retire') {
      take(found)
      found.forEach(({ raw }) => plan.retired!.set(keyOf(raw), op.reason))
      lost += loss
      return null
    }
    const text = squash(op.text)
    const sources = found.map(({ fact }) => fact.text)
    if ([text, ...sources].some(hasMeaningWords)) {
      return 'rewrites a line with a negation or modal; move it or leave it'
    }
    if (text === '' || text.length > MAX_LINE_CHARS || !isDerivable(text, sources)) {
      return 'says more than the lines it rewrites'
    }
    const kind = botMemoryLineKind(text).kind
    if (kind !== null && !sources.some((source) => botMemoryLineKind(source).kind === kind)) {
      return 'gives the line a kind its lines don’t have'
    }
    const dates = found.flatMap(({ fact }) => fact.date ?? []).toSorted()
    const line = `- ${(op.op === 'merge' ? dates[0] : input.today) ?? input.today} ${text}`
    if (redactSecretLike(line) !== line) {
      return 'looks like a secret'
    }
    // A rewrite into a line MEMORY.md already has would take out more than it counts.
    if (existing(line) && !found.some(({ raw }) => keyOf(raw) === keyOf(line))) {
      return 'says what another line already says; merge that line in too'
    }
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
  // Lines leave by their words: the apply checks the live file still has exactly these copies.
  plan.groups = lineGroups(removed.map(({ raw }) => raw))
  return { plan, skipped }
}

/** The lines stating each fact `lines` holds, by its words, exactly as written: the apply checks
 *  the live file still has exactly these, so a copy rewritten or added since (say, undated by the
 *  owner) is never taken with them. */
export function lineGroups(lines: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const line of lines) {
    const group = groups.get(keyOf(line))
    if (group) {
      group.push(line.trimEnd())
    } else {
      groups.set(keyOf(line), [line.trimEnd()])
    }
  }
  return new Map([...groups].map(([key, group]) => [key, group.toSorted()]))
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
