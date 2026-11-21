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
import { isProtectedBotMemoryLine } from '../../shared/bot-memory-line-kinds'
import { redactSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
import { TIDY_UP_ARCHIVE } from './bot-memory-tidy-up'
import { TIDY_UP_TOPIC_NAME, type TidyUpPlan } from './bot-memory-tidy-up-draft'

/** Share of the snapshot's lines that may leave MEMORY.md by retire, replace or merge in one run. */
export const TIDY_UP_OPS_MAX_LOSS = 0.25

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

const OpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('merge'),
    lines: z.array(z.string()).min(2).max(8),
    /** The named line that stays, word for word; the others go to the archive. */
    keep: z.string()
  }),
  z.object({
    op: z.literal('retire'),
    line: z.string(),
    reason: z.enum(['stale', 'done', 'wrong', 'not-a-lesson'])
  }),
  z.object({
    op: z.literal('demote'),
    lines: z.array(z.string()).optional(),
    range: z.tuple([z.string(), z.string()]).optional(),
    topic: z.string()
  })
])
type Op = z.infer<typeof OpSchema>

const keyOf = (line: string): string => botMemoryLineKey({ line, after: null }) ?? line.trim()

/**
 * What the ops do to MEMORY.md as the run read it, as a Tidy-up plan, and why each skipped op was
 * skipped. Owner rules and undated lines, and every copy of them, are never touched: the owner
 * edits those. A line with a negation or modal is never rewritten, only moved or left. No op adds
 * a line: new lines come from the owner and the bot's own turns. Lines leave with every copy.
 */
export function checkTidyUpOps(
  memory: string,
  ops: readonly unknown[]
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
  const plan: TidyUpPlan = {
    change: { added: [], removed: [] },
    kept: new Map(),
    topics: new Map(),
    filed: new Set(),
    replaced: new Set(),
    merged: new Set(),
    retired: new Map(),
    // Ops never learn a line; the summary reads this to count none.
    learned: new Set(),
    merges: 0
  }
  const skipped: string[] = []
  const lossCap = Math.max(1, Math.floor(snapshot.length * TIDY_UP_OPS_MAX_LOSS))
  let lost = 0
  const keeps: MemorySnapshotLine[] = []
  // History can't keep a secret-looking line, or the line it sits under, for Undo.
  const secretish = ({ raw, after }: MemorySnapshotLine): boolean =>
    redactSecretLike(raw) !== raw || (after !== null && redactSecretLike(after) !== after)
  const take = (lines: MemorySnapshotLine[]): void => {
    for (const line of lines) {
      used.add(line.ref)
      removed.push(line)
    }
  }
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
      if (found.some(fixed)) {
        return "names your owner's rule or an undated line, which only your owner changes"
      }
      if (found.length > picked.length) {
        return 'names a line MEMORY.md states more than once; only your owner tidies those'
      }
      return found.some(secretish)
        ? 'names a line that looks like a secret, or sits under one; only your owner moves it'
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
        const inRange = snapshot
          .slice(from, to + 1)
          .filter((line) => !fixed(line) && groupOf(line).length === 1 && !secretish(line))
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
    if (op.op === 'retire') {
      if (lost + found.length > lossCap) {
        return 'takes out more lines than one tidy-up may'
      }
      take(found)
      found.forEach(({ raw }) => plan.retired!.set(keyOf(raw), op.reason))
      lost += found.length
      return null
    }
    // A merge writes nothing new: the line it keeps stays word for word, the rest are archived.
    const kept = byRef.get(op.keep.trim())
    if (!kept || !op.lines.some((ref) => ref.trim() === kept.ref)) {
      return 'keeps a line it doesn’t name'
    }
    const going = found.filter(({ raw }) => keyOf(raw) !== keyOf(kept.raw))
    if (going.length === 0) {
      return 'merges fewer than two different lines'
    }
    if (lost + going.length > lossCap) {
      return 'takes out more lines than one tidy-up may'
    }
    // The kept line must still be there as it was, and no later op may take it.
    keeps.push(...groupOf(kept))
    groupOf(kept).forEach(({ ref }) => used.add(ref))
    take(going)
    lost += going.length
    going.forEach(({ raw }) => plan.merged!.add(keyOf(raw)))
    plan.merges! += 1
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
  plan.change = { added: [], removed: removed.map(changeLine) }
  // Lines leave by their words: the apply checks the live file still has exactly these copies.
  plan.groups = lineGroups([...removed, ...keeps].map(({ raw }) => raw))
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
