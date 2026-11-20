import type { z } from 'zod'
import type {
  LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS,
  LEGACY_JOURNAL_RETIREMENT_WAITING_STAGES,
  legacyJournalRetirementSchema
} from '../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'
import type { LegacySourceRefusalReason } from './journal-legacy-retention-error'

export type LegacyJournalRetirementEvent = z.infer<typeof legacyJournalRetirementSchema>
type Sink = (event: LegacyJournalRetirementEvent) => Promise<unknown>

/** The desktop's backend registers one; a host without a desktop (headless orcad) only logs. */
let sink: Sink | undefined

export function setLegacyJournalRetirementSink(next: Sink | undefined): void {
  sink = next
}

const MB = 1024 * 1024
function bytesBucket(bytes: number): (typeof LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS)[number] {
  return bytes < 100 * MB
    ? 'lt_100mb'
    : bytes < 1024 * MB
      ? '100mb_1gb'
      : bytes < 10 * 1024 * MB
        ? '1gb_10gb'
        : bytes < 50 * 1024 * MB
          ? '10gb_50gb'
          : 'gte_50gb'
}

export type LegacyJournalRetirementOutcome =
  | { kind: 'retired'; bytes: number }
  | { kind: 'refused'; reason: LegacySourceRefusalReason }
  | { kind: 'waiting'; stage: (typeof LEGACY_JOURNAL_RETIREMENT_WAITING_STAGES)[number] }

/** Once per launch: the old journal was deleted, a saved refusal keeps it, or it waits. */
export function reportLegacyJournalRetirement(outcome: LegacyJournalRetirementOutcome): void {
  const event: LegacyJournalRetirementEvent =
    outcome.kind === 'retired'
      ? { outcome: 'retired', bytes_bucket: bytesBucket(outcome.bytes) }
      : outcome.kind === 'refused'
        ? { outcome: 'refused', reason: outcome.reason }
        : { outcome: 'waiting', stage: outcome.stage }
  console.warn(`[agent-session-journal] old chat journal: ${describe(event)}`)
  // Reporting never holds up or fails the cleanup.
  try {
    void sink?.(event).catch(() => {})
  } catch {}
}

function describe(event: LegacyJournalRetirementEvent): string {
  return event.outcome === 'retired'
    ? `deleted (${event.bytes_bucket})`
    : event.outcome === 'refused'
      ? `kept, refused: ${event.reason}`
      : `kept for now: ${event.stage}`
}
