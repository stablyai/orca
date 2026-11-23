import type { z } from 'zod'
import {
  LEGACY_JOURNAL_RETIREMENT_COUNT_BUCKETS,
  type LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS,
  type LEGACY_JOURNAL_RETIREMENT_DURATION_BUCKETS,
  type legacyJournalRetirementSchema
} from '../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'
import { LEGACY_PROOF_LAYOUT, type LegacyProofCounts } from './journal-legacy-retirement-state'
import { isSqliteCorruption, isSqliteStorageFailure } from '../../sqlite/sqlite-read-failure'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'

export type LegacyJournalRetirementEvent = z.infer<typeof legacyJournalRetirementSchema>

/**
 * Where the process running the cleanup reports an outcome. The desktop's main process registers
 * it; a host without one (headless orcad) reports to its log only.
 */
type Host = {
  report: (event: LegacyJournalRetirementEvent) => Promise<unknown>
  /** Whether a report would be taken now; a cheap check before resending one that wasn't. */
  accepting?: () => boolean
}
let host: Host | undefined

export function setLegacyJournalRetirementHost(next: Host | undefined): void {
  host = next
}

export type LegacyJournalRetirementOutcome = Pick<
  LegacyJournalRetirementEvent,
  'outcome' | 'reason' | 'defer' | 'artifact' | 'error' | 'deletes' | 'completeness' | 'resumed'
> & {
  counts: LegacyProofCounts | null
  /** The counts cover every page from the first, so they only grow; never sent. */
  cumulative: boolean
  sourceBytes: number | null
  activeMs: number | null
  elapsedMs: number | null
}

export function legacyJournalRetirementEvent(
  outcome: LegacyJournalRetirementOutcome
): LegacyJournalRetirementEvent {
  const { counts, cumulative: _cumulative, sourceBytes, activeMs, elapsedMs, ...fields } = outcome
  return {
    ...fields,
    inventory_revision: LEGACY_PROOF_LAYOUT,
    chats_bucket: countBucket(counts?.chats),
    already_converted_bucket: countBucket(counts?.alreadyConverted),
    newly_converted_bucket: countBucket(counts?.newlyConverted),
    deleted_here_bucket: countBucket(counts?.deletedHere),
    drafts_bucket: countBucket(counts?.drafts),
    originals_bucket: countBucket(counts?.originals),
    copies_bucket: countBucket(counts?.copies),
    source_bytes_bucket: bytesBucket(sourceBytes),
    active_ms_bucket: durationBucket(activeMs),
    elapsed_ms_bucket: durationBucket(elapsedMs)
  }
}

/** The local log line: no content, paths or ids, like the event. */
function logLegacyJournalRetirement(event: LegacyJournalRetirementEvent): void {
  console.warn(
    `[agent-session-journal] old chat journal: ${event.outcome}` +
      ` (reason ${event.reason}, defer ${event.defer}, error ${event.error}, artifact ${event.artifact},` +
      ` ${event.deletes ? 'deletes' : 'keeps'},` +
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

function countBucket(
  count: number | undefined
): (typeof LEGACY_JOURNAL_RETIREMENT_COUNT_BUCKETS)[number] {
  return count === undefined
    ? 'unknown'
    : count === 0
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
 * Logs every launch's outcome; reports it when it, its progress buckets or the app version differ
 * from what this store last reported, so a saved state yields one report per version.
 */
export class LegacyJournalRetirementReporter {
  private last: string | null | undefined
  private readonly logged = new Set<string>()
  /** The latest report the usage client didn't take, sent again once it would. */
  private unsent: { event: LegacyJournalRetirementEvent; signature: string } | null = null

  constructor(
    private readonly writer: {
      maintain(operation: { kind: 'legacy-retirement-reported'; value: string }): Promise<unknown>
    },
    private readonly version: string | null,
    private readonly deletes: boolean
  ) {}

  /** What the store last recorded; read once per launch, before the first report. */
  saved(reported: string | null): void {
    this.last ??= reported
  }

  async report(fields: Partial<LegacyJournalRetirementOutcome>): Promise<void> {
    const event = legacyJournalRetirementEvent({
      outcome: 'deferred',
      reason: 'none',
      defer: 'none',
      artifact: 'unknown',
      completeness: 'unknown',
      resumed: false,
      counts: null,
      cumulative: false,
      sourceBytes: null,
      activeMs: null,
      elapsedMs: null,
      error: 'none',
      // A field passed as undefined keeps its default rather than leaving the event invalid.
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      deletes: this.deletes
    })
    const outcome = JSON.stringify([
      event.outcome,
      event.reason,
      event.defer,
      event.artifact,
      event.error,
      event.deletes,
      event.completeness,
      // A refusal stands whatever the file's size since; only the size of a file still in play is news.
      event.outcome === 'refused' ? null : event.source_bytes_bucket,
      this.version
    ])
    // Progress by bucket, once counts cover every page: a walk that got further is reported, a few
    // times at most. Only forward: a launch that restarted below unsaved progress isn't news.
    const progress = fields.cumulative
      ? [event.chats_bucket, event.newly_converted_bucket, event.copies_bucket].map((bucket) =>
          LEGACY_JOURNAL_RETIREMENT_COUNT_BUCKETS.indexOf(bucket)
        )
      : []
    const signature = JSON.stringify([outcome, progress])
    // Logged once per launch for each distinct outcome, however often a retry repeats it.
    if (!this.logged.has(signature)) {
      this.logged.add(signature)
      logLegacyJournalRetirement(event)
    }
    // Whatever it says, this observation supersedes a refused older one.
    this.unsent = null
    if (this.news(outcome, progress)) {
      await this.deliver(event, signature)
    }
  }

  /** A report the usage client refused (no consent yet, say) goes once it would take it. */
  async resendUnsent(): Promise<void> {
    if (this.unsent && host?.accepting?.() === true) {
      await this.deliver(this.unsent.event, this.unsent.signature)
    }
  }

  // Marked reported only once the usage client took it, so a dropped event is sent again later.
  private async deliver(event: LegacyJournalRetirementEvent, signature: string): Promise<void> {
    if (!(await sendLegacyJournalRetirement(event))) {
      this.unsent = { event, signature }
      return
    }
    this.unsent = null
    this.last = signature
    // A failed note only means the next launch sends it again; it never fails the cleanup.
    await this.writer
      .maintain({ kind: 'legacy-retirement-reported', value: signature })
      .catch(() => {})
  }

  /** A different outcome than last reported, or the same one further along. */
  private news(outcome: string, progress: number[]): boolean {
    let last: unknown
    try {
      last = this.last ? JSON.parse(this.last) : null
    } catch {
      return true
    }
    if (!Array.isArray(last) || last[0] !== outcome || !Array.isArray(last[1])) {
      return true
    }
    const before: unknown[] = last[1]
    return progress.some((bucket, index) => bucket > Number(before[index] ?? -1))
  }
}

/**
 * What a failed attempt reports, by kind only: an error's text can name paths or chats. A refusal
 * reports at once; anything else is tried again, and a check still waiting to settle (a compare,
 * an older Orca's writes) reads as pending.
 */
export function legacyProofFailureOutcome(
  error: unknown,
  {
    counts,
    resumed,
    whole
  }: { counts: LegacyProofCounts | null; resumed: boolean; whole: boolean },
  proven: boolean,
  stopping = false
): Partial<LegacyJournalRetirementOutcome> {
  const walked = {
    completeness: 'partial',
    counts,
    cumulative: whole && counts !== null,
    resumed
  } as const
  if (error instanceof JournalLegacyRetentionError) {
    return error.reason
      ? {
          outcome: 'refused',
          reason: error.reason,
          artifact: error.artifact ?? 'unknown',
          ...walked,
          // A saved refusal keeps no counts, so later launches can't repeat these: not keyed on.
          cumulative: false
        }
      : { outcome: 'proving', error: 'pending', ...walked }
  }
  // After a finished proof, only the removal itself (its commit or lock) can fail.
  // Quitting closes what the proof waits on, whatever that failure then says.
  const kind = stopping ? 'interrupted' : legacyProofErrorKind(error)
  return proven
    ? { outcome: 'delete_failed', error: kind, ...walked }
    : { outcome: 'proving', error: kind, ...walked }
}

function legacyProofErrorKind(error: unknown): LegacyJournalRetirementEvent['error'] {
  if (!(error instanceof Error)) {
    return 'other'
  }
  if (
    error.name === 'AbortError' ||
    error.message === 'legacy proof was interrupted' ||
    // Quitting stops the conversion the proof waits on.
    error.message === 'journal maintenance stopped'
  ) {
    return 'interrupted'
  }
  if (error.message.includes('conversion')) {
    if (error.name === 'JournalConversionStorageError') {
      return 'storage'
    }
    return 'conversion'
  }
  return isSqliteStorageFailure(error) || isSqliteCorruption(error) ? 'storage' : 'other'
}
