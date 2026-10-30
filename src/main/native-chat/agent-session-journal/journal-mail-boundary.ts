import { z } from 'zod'
import type { JournalRow } from './journal-row-schema'

const cursor = z.object({ sessionId: z.string(), epoch: z.string(), sequence: z.int().positive() })
const cut = z.object({ incarnation: z.string().min(1), throughSequence: z.int().nonnegative() })
const boundary = z.discriminatedUnion('status', [
  z.object({ version: z.literal(2), status: z.literal('released'), at: cursor }),
  z.object({
    version: z.literal(2),
    status: z.literal('held'),
    stop: cursor.nullable(),
    cut: cut.optional()
  })
])
const source = z.object({
  incarnation: z.string().min(1),
  sequence: z.int().positive(),
  origin: z.enum(['local', 'imported']).nullable()
})
export type JournalMailBoundary = z.infer<typeof boundary>
export type JournalMailCut = z.infer<typeof cut>
export type JournalMailSource = z.infer<typeof source>

export function readJournalMailBoundary(value: unknown): JournalMailBoundary | undefined {
  const parsed = boundary.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
export function readJournalMailSource(value: unknown): JournalMailSource | undefined {
  const parsed = source.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
export function unknownJournalMailBoundary(): JournalMailBoundary {
  return { version: 2, status: 'held', stop: null }
}
export function releasedJournalMailBoundary(
  sessionId: string,
  epoch: string,
  sequence: number
): JournalMailBoundary {
  return { version: 2, status: 'released', at: { sessionId, epoch, sequence } }
}

/** Only a matching local sequence domain can prove a report was created after Stop. */
export function journalMailSourceEligible(
  intent: JournalMailBoundary | undefined,
  report: JournalMailSource | undefined,
  freshOrigin = false
): boolean {
  if (!intent) {
    return freshOrigin
  }
  if (intent.status === 'released') {
    return true
  }
  return Boolean(
    intent.cut &&
    report?.origin === 'local' &&
    report.incarnation === intent.cut.incarnation &&
    report.sequence > intent.cut.throughSequence
  )
}

export function foldJournalMailBoundary(
  prior: JournalMailBoundary | undefined,
  row: JournalRow,
  sessionId: string
): JournalMailBoundary | undefined {
  const stated = readJournalMailBoundary(row.mailBoundary)
  if (stated) {
    return stated
  }
  // Preserve the enclosing Stop even when its optional source annotation is unreadable.
  if (row.kind === 'tombstone' && row.stopEvent?.reason === 'user-stop') {
    return { version: 2, status: 'held', stop: { sessionId, epoch: row.epoch, sequence: row.seq } }
  }
  return prior
}
