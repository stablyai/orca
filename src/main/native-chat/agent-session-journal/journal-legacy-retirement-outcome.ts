import type { z } from 'zod'
import type {
  LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS,
  LEGACY_JOURNAL_RETIREMENT_COUNT_BUCKETS,
  LEGACY_JOURNAL_RETIREMENT_DURATION_BUCKETS,
  legacyJournalRetirementSchema
} from '../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'
import { LEGACY_PROOF_LAYOUT, type LegacyProofCounts } from './journal-legacy-retirement-state'
import { isSqliteCorruption, isSqliteStorageFailure } from '../../sqlite/sqlite-read-failure'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'

export type LegacyJournalRetirementEvent = z.infer<typeof legacyJournalRetirementSchema>
export type LegacyJournalRetirementMode = { mode: 'off' | 'report' | 'enforce'; revision: number }

/**
 * What the process running the cleanup can ask of the desktop: report an outcome, and read the
 * cleanup policy. The desktop's backend registers both; a host without a desktop (headless orcad)
 * reports to its log only and never deletes.
 */
type Host = {
  report: (event: LegacyJournalRetirementEvent) => Promise<unknown>
  mode: () => Promise<unknown>
}
let host: Host | undefined

export function setLegacyJournalRetirementHost(next: Host | undefined): void {
  host = next
}

/** No answer, or anything but a valid one, reads as `report`: deletion needs fresh permission. */
export async function legacyJournalRetirementMode(): Promise<LegacyJournalRetirementMode> {
  try {
    const answer: unknown = await host?.mode()
    if (
      typeof answer === 'object' &&
      answer !== null &&
      'mode' in answer &&
      'revision' in answer &&
      (answer.mode === 'off' || answer.mode === 'report' || answer.mode === 'enforce') &&
      typeof answer.revision === 'number' &&
      Number.isInteger(answer.revision) &&
      answer.revision >= 0
    ) {
      return { mode: answer.mode, revision: Math.min(answer.revision, 1_000_000) }
    }
  } catch {}
  return { mode: 'report', revision: 0 }
}

export type LegacyJournalRetirementOutcome = Pick<
  LegacyJournalRetirementEvent,
  | 'outcome'
  | 'reason'
  | 'defer'
  | 'artifact'
  | 'error'
  | 'mode'
  | 'policy_revision'
  | 'completeness'
  | 'resumed'
> & {
  counts: LegacyProofCounts | null
  sourceBytes: number | null
  activeMs: number | null
  elapsedMs: number | null
}

export function legacyJournalRetirementEvent(
  outcome: LegacyJournalRetirementOutcome
): LegacyJournalRetirementEvent {
  const { counts, sourceBytes, activeMs, elapsedMs, ...fields } = outcome
  return {
    ...fields,
    inventory_revision: LEGACY_PROOF_LAYOUT,
    chats_bucket: countBucket(counts?.chats ?? 0),
    already_converted_bucket: countBucket(counts?.alreadyConverted ?? 0),
    newly_converted_bucket: countBucket(counts?.newlyConverted ?? 0),
    deleted_here_bucket: countBucket(counts?.deletedHere ?? 0),
    drafts_bucket: countBucket(counts?.drafts ?? 0),
    originals_bucket: countBucket(counts?.originals ?? 0),
    copies_bucket: countBucket(counts?.copies ?? 0),
    source_bytes_bucket: bytesBucket(sourceBytes),
    active_ms_bucket: durationBucket(activeMs),
    elapsed_ms_bucket: durationBucket(elapsedMs)
  }
}

/** The local log line: no content, paths or ids, like the event. */
function logLegacyJournalRetirement(event: LegacyJournalRetirementEvent): void {
  console.warn(
    `[agent-session-journal] old chat journal: ${event.outcome}` +
      ` (reason ${event.reason}, defer ${event.defer}, error ${event.error}, mode ${event.mode} r${event.policy_revision},` +
      ` ${event.completeness}${event.resumed ? ', resumed' : ''}, chats ${event.chats_bucket},` +
      ` size ${event.source_bytes_bucket}, took ${event.active_ms_bucket})`
  )
}

/** True only when the usage client took the event (consent given, under its limits). */
export async function sendLegacyJournalRetirement(
  event: LegacyJournalRetirementEvent
): Promise<boolean> {
  // Reporting never fails the cleanup.
  try {
    return (await host?.report(event)) === true
  } catch {
    return false
  }
}

function countBucket(count: number): (typeof LEGACY_JOURNAL_RETIREMENT_COUNT_BUCKETS)[number] {
  return count === 0
    ? '0'
    : count <= 10
      ? '1_10'
      : count <= 100
        ? '11_100'
        : count <= 1000
          ? '101_1000'
          : count <= 10_000
            ? '1001_10000'
            : 'gt_10000'
}

const MB = 1024 * 1024
function bytesBucket(
  bytes: number | null
): (typeof LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS)[number] {
  return bytes === null
    ? 'unknown'
    : bytes < 100 * MB
      ? 'lt_100mb'
      : bytes < 1024 * MB
        ? '100mb_1gb'
        : bytes < 10 * 1024 * MB
          ? '1gb_10gb'
          : bytes < 50 * 1024 * MB
            ? '10gb_50gb'
            : 'gte_50gb'
}

function durationBucket(
  ms: number | null
): (typeof LEGACY_JOURNAL_RETIREMENT_DURATION_BUCKETS)[number] {
  return ms === null
    ? 'unknown'
    : ms < 1000
      ? 'lt_1s'
      : ms < 10_000
        ? '1s_10s'
        : ms < 60_000
          ? '10s_1m'
          : ms < 600_000
            ? '1m_10m'
            : ms < 3_600_000
              ? '10m_1h'
              : 'gte_1h'
}

/**
 * Logs every launch's outcome; reports it when it differs from what this store last reported, or
 * the app version or policy revision changed, so a saved state yields one report per version.
 */
export class LegacyJournalRetirementReporter {
  private last: string | null | undefined
  private readonly logged = new Set<string>()

  constructor(
    private readonly writer: {
      maintain(operation: { kind: 'legacy-retirement-reported'; value: string }): Promise<unknown>
    },
    private readonly version: string | null
  ) {}

  /** What the store last recorded; read once per launch, before the first report. */
  saved(reported: string | null): void {
    this.last ??= reported
  }

  async report(
    fields: Partial<LegacyJournalRetirementOutcome>,
    policy: LegacyJournalRetirementMode
  ): Promise<void> {
    const event = legacyJournalRetirementEvent({
      outcome: 'deferred',
      reason: 'none',
      defer: 'none',
      artifact: 'none',
      completeness: 'unknown',
      resumed: false,
      counts: null,
      sourceBytes: null,
      activeMs: null,
      elapsedMs: null,
      error: 'none',
      // A field passed as undefined keeps its default rather than leaving the event invalid.
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      mode: policy.mode,
      policy_revision: policy.revision
    })
    const signature = JSON.stringify([
      event.outcome,
      event.reason,
      event.defer,
      event.artifact,
      event.error,
      event.mode,
      event.policy_revision,
      this.version
    ])
    // Logged once per launch for each distinct outcome, however often a retry repeats it.
    if (!this.logged.has(signature)) {
      this.logged.add(signature)
      logLegacyJournalRetirement(event)
    }
    // Marked reported only once the usage client took it, so a dropped event is sent again later.
    if (signature !== this.last && (await sendLegacyJournalRetirement(event))) {
      this.last = signature
      // A failed note only means the next launch sends it again; it never fails the cleanup.
      await this.writer
        .maintain({ kind: 'legacy-retirement-reported', value: signature })
        .catch(() => {})
    }
  }
}

/**
 * What a failed attempt reports, by kind only: an error's text can name paths or chats. A refusal
 * reports at once; anything else is tried again, and a check still waiting to settle (a compare,
 * an older Orca's writes) reads as pending.
 */
export function legacyProofFailureOutcome(
  error: unknown,
  counts: LegacyProofCounts,
  proven: boolean
): Partial<LegacyJournalRetirementOutcome> {
  const walked = { completeness: 'partial', counts } as const
  if (error instanceof JournalLegacyRetentionError) {
    return error.reason
      ? { outcome: 'refused', reason: error.reason, artifact: error.artifact ?? 'none', ...walked }
      : { outcome: 'proving', error: 'pending', ...walked }
  }
  // After a finished proof, only the removal itself (its commit or lock) can fail.
  return proven
    ? { outcome: 'delete_failed', error: legacyProofErrorKind(error), ...walked }
    : { outcome: 'proving', error: legacyProofErrorKind(error), ...walked }
}

function legacyProofErrorKind(error: unknown): LegacyJournalRetirementEvent['error'] {
  if (!(error instanceof Error)) {
    return 'other'
  }
  if (error.name === 'AbortError' || error.message === 'legacy proof was interrupted') {
    return 'interrupted'
  }
  if (error.message.includes('conversion')) {
    return 'conversion'
  }
  return isSqliteStorageFailure(error) || isSqliteCorruption(error) ? 'storage' : 'other'
}
