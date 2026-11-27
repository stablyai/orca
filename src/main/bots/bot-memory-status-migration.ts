// The move of status lines (PR numbers, review rounds, worker and message ids, SHAs, "pending") out
// of MEMORY.md into the month's journal file, word for word and without a model. It rides in a
// Tidy-up's one History row, so Undo puts every line back.
import { botMemoryLineKey } from '../../shared/bot-memory-lines'
import { redactSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
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
 *  stay, as every tidy-up keeps them, and so does a line `exempt` reads as the owner deciding: it
 *  stays in MEMORY.md until the owner or the bot retires it, so silence never loses a decision. */
export function statusMigrationPlan(
  memory: string,
  today: string,
  exempt: (text: string) => boolean = () => false
): TidyUpPlan | null {
  const snapshot = memorySnapshot(memory)
  const key = (raw: string): string | null => botMemoryLineKey({ line: raw, after: null })
  // Every line grouped by its words first; a group moves only when it is one dated status line
  // that neither looks like a secret nor sits under one: History restores one line per fact and
  // can't keep a secret for Undo, so anything else stays for the owner.
  const all = new Map<string | null, typeof snapshot>()
  for (const line of snapshot) {
    const group = all.get(key(line.raw))
    if (group) {
      group.push(line)
    } else {
      all.set(key(line.raw), [line])
    }
  }
  const secret = ({ raw, after }: (typeof snapshot)[number]): boolean =>
    redactSecretLike(raw) !== raw || (after !== null && redactSecretLike(after) !== after)
  const groups = new Map(
    [...all].filter(
      ([, group]) =>
        group.length === 1 &&
        group[0].fact.date !== null &&
        isStatusLine(group[0].fact.text) &&
        !exempt(group[0].fact.text) &&
        !secret(group[0])
    )
  )
  const oldest = new Map(
    [...groups.values()].map((group) => [
      group,
      group.reduce((min, { fact }) => ((fact.date ?? '') < min ? (fact.date ?? '') : min), '9999')
    ])
  )
  const byAge = [...groups.values()].toSorted((a, b) =>
    (oldest.get(a) ?? '').localeCompare(oldest.get(b) ?? '')
  )
  const status: typeof snapshot = []
  for (const group of byAge) {
    if (status.length > 0 && status.length + group.length > STATUS_MIGRATION_MAX_LINES) {
      continue
    }
    status.push(...group)
    if (status.length >= STATUS_MIGRATION_MAX_LINES) {
      break
    }
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
