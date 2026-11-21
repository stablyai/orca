// The move of status lines (PR numbers, review rounds, worker and message ids, SHAs, "pending") out
// of MEMORY.md into the month's journal file, word for word and without a model. It rides in a
// Tidy-up's one History row, so Undo puts every line back.
import { botMemoryLineKey } from '../../shared/bot-memory-lines'
import { botMemoryLineKind, isOwnerRuleLine } from '../../shared/bot-memory-line-kinds'
import type { TidyUpPlan } from './bot-memory-tidy-up-draft'
import { lineGroups, memorySnapshot } from './bot-memory-ops'

/** Lines one run moves, oldest first; the rest wait for the next run. */
export const STATUS_MIGRATION_MAX_LINES = 1_000

const STATUS_MARKERS = [
  /(?:(?<![\w/])#|\/pull\/)\d{2,6}\b|\bPR\s*#?\d{2,6}\b/i,
  /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/,
  /\b(?:ctx|msg|task|dispatch|term|wf)_[0-9a-z]{6,}\b/,
  /\b(?:UX-[DI]\d|[CDR]\d)\b/,
  /\bround\s*\d\b/i,
  /\bitems?\s+#?\d{2,5}\b/i,
  /\b(?:pending|waiting)\b/i,
  /\b(?:merged|CI green|CI red|head)\b/i
]

export function statusMarkerCount(text: string): number {
  return STATUS_MARKERS.filter((marker) => marker.test(text)).length
}

/** Status, by two or more different markers; never a typed line or an owner rule. */
export function isStatusLine(text: string): boolean {
  return (
    statusMarkerCount(text) >= 2 && botMemoryLineKind(text).kind === null && !isOwnerRuleLine(text)
  )
}

export function journalTopic(today: string): string {
  return `journal/${today.slice(0, 7)}`
}

/** Moves the dated status lines to this month's journal; null when there are none. Undated lines
 *  stay, as every tidy-up keeps them. */
export function statusMigrationPlan(memory: string, today: string): TidyUpPlan | null {
  const snapshot = memorySnapshot(memory)
  const key = (raw: string): string | null => botMemoryLineKey({ line: raw, after: null })
  // Lines leave by their words, so a line whose copy must stay (undated, an owner rule) stays too.
  const kept = new Set(
    snapshot
      .filter(({ fact }) => fact.date === null || !isStatusLine(fact.text))
      .map(({ raw }) => key(raw))
  )
  // Whole groups of copies, oldest first, until the run's share is used.
  const status: typeof snapshot = []
  const groups = new Map<string | null, typeof snapshot>()
  for (const line of snapshot) {
    if (line.fact.date !== null && isStatusLine(line.fact.text) && !kept.has(key(line.raw))) {
      groups.set(key(line.raw), [...(groups.get(key(line.raw)) ?? []), line])
    }
  }
  const oldest = (group: typeof snapshot): string =>
    group.map(({ fact }) => fact.date ?? '').toSorted()[0] ?? ''
  for (const group of [...groups.values()].toSorted((a, b) => oldest(a).localeCompare(oldest(b)))) {
    if (status.length + group.length > STATUS_MIGRATION_MAX_LINES) {
      break
    }
    status.push(...group)
  }
  if (status.length === 0) {
    return null
  }
  const topic = journalTopic(today)
  return {
    change: { added: [], removed: status.map(({ raw, after }) => ({ line: raw, after })) },
    kept: new Map(),
    topics: new Map([
      [
        topic,
        [
          `# Status moved out of MEMORY.md, ${today.slice(0, 7)}`,
          ...status.map(({ raw }) => raw.trimEnd())
        ]
      ]
    ]),
    filed: new Set(status.flatMap(({ raw }) => botMemoryLineKey({ line: raw, after: null }) ?? [])),
    replaced: new Set(),
    groups: lineGroups(status.map(({ raw }) => raw))
  }
}
