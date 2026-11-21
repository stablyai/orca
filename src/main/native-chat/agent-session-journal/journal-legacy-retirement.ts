import { JournalLegacyIneligibleError } from './journal-legacy-retention-error'
import { ownsOrcadProfileDirectory } from '../../orcad/instance-lock/orcad-instance-lock-hold'
import {
  journalDatabasePath,
  journalDomainDatabasePath,
  journalRunningOrcaVersion
} from './database/journal-host-database'
import {
  legacyDestinationIdentity,
  legacyFilePresent,
  legacyCompanionsPresent,
  removeLeftoverLegacyCompanions
} from './journal-legacy-retirement-files'
import {
  LEGACY_PROOF_LAYOUT,
  type LegacySourceHeld,
  type LegacySourceRetiring
} from './journal-legacy-retirement-state'
import {
  acquireJournalLegacyFileLock,
  createJournalLegacyFileEligibility
} from './journal-legacy-file-lock'
import type { JournalSqlOwner } from './journal-sql-owner'
import {
  LegacyJournalRetirementReporter,
  legacyProofFailureOutcome,
  type LegacyJournalRetirementOutcome
} from './journal-legacy-retirement-outcome'
import { LEGACY_JOURNAL_RETIREMENT_DELETES } from './journal-legacy-retirement-deletion'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import { JournalLegacyProof, type LegacyProofObservation } from './journal-legacy-proof'
import {
  absorbedWal,
  deletedBefore,
  observeLegacySource,
  heldFor,
  laterVersion,
  legacySourceUnchanged,
  walkedFor,
  type FinishedWalk,
  legacyProofWaits,
  provenOutcome,
  readRetirementState,
  sourceBytes
} from './journal-legacy-retirement-held'

/**
 * Deletes the original journal once this store provably holds all of it, read from content: on a
 * later Orca version than the one that copied the profile, after the older-Orca reconcile absorbed
 * the original as it is now, with every chat held here (converted, or deleted here) and its
 * uploads claimed. Where a chat's record or waiting text differ on the two sides, the original's
 * version is kept here verbatim first. Tabs an older Orca opened or closed are not adopted by
 * design. Every failed check keeps the file and retries later.
 */
export class JournalLegacyRetirement {
  private readonly filename: string
  private readonly stopped = new AbortController()
  private readonly proof: JournalLegacyProof
  private diagnosed?: string
  private retryAt = 0
  private retryDelay = 60_000
  private done = false
  private readonly reporter: LegacyJournalRetirementReporter
  private activeMs = 0
  private readonly waits = legacyProofWaits()
  private firstAttemptAt: number | undefined
  // What the proof read this launch, so a failed attempt still reports the file's size.
  private observed: (LegacyProofObservation & { walBytes: string }) | undefined
  // The first finished walk this launch: a retry walks only from saved progress, so counts less.
  private finishedWalk: FinishedWalk | undefined
  // Removing the side files a removal cut short left, after the main file was gone.
  private leftovers = false

  constructor(
    private readonly directory: string,
    private readonly writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<
      JournalSqlReaderPool,
      'legacyProof' | 'importState' | 'recycleSourceReaders' | 'releaseSourceReaders'
    >,
    conversions: Pick<JournalSqlConversions, 'ensure'>,
    boundary: () => Promise<boolean>,
    private readonly report: (error: unknown) => void,
    private readonly ownsProfile = () => ownsOrcadProfileDirectory(directory),
    private readonly lock = acquireJournalLegacyFileLock,
    rest: (started: number) => Promise<void> = async () => {},
    private readonly eligibility = createJournalLegacyFileEligibility(),
    private readonly version = journalRunningOrcaVersion(),
    private readonly deletes = LEGACY_JOURNAL_RETIREMENT_DELETES
  ) {
    this.filename = journalDatabasePath(directory)
    this.reporter = new LegacyJournalRetirementReporter(writer, version, deletes)
    this.proof = new JournalLegacyProof(
      writer,
      readers,
      // A conversion can wait for idle inside, so active time leaves conversions out entirely.
      { ensure: this.waits.timed((id, foreground) => conversions.ensure(id, foreground)) },
      this.waits.timed(boundary),
      this.stopped.signal,
      this.waits.timed(rest)
    )
  }

  stop(): void {
    this.stopped.abort()
  }

  async run(): Promise<void> {
    try {
      await this.attempt()
    } catch (error) {
      // Unsupported storage or file identity doesn't change while this process runs.
      if (error instanceof JournalLegacyIneligibleError && !this.done) {
        this.done = true
        await this.outcome({ outcome: 'deferred', defer: 'unsupported_storage' }).catch(() => {})
      } else if (this.leftovers) {
        await this.outcome({ outcome: 'deferred', defer: 'leftover_files' }).catch(() => {})
      } else {
        const removing = this.proof.finished && this.deletes
        const failed = legacyProofFailureOutcome(
          error,
          walkedFor(this.finishedWalk, this.observed) ?? this.proof.walked,
          removing,
          this.stopped.signal.aborted
        )
        const bytes = this.observed ? sourceBytes(this.observed) : null
        await this.outcome({ ...failed, sourceBytes: bytes, activeMs: this.activeMs }).catch(
          () => {}
        )
      }
      this.later()
      const reason = error instanceof Error ? error.message : String(error)
      if (this.diagnosed !== reason) {
        this.diagnosed = reason
        this.report(error)
      }
    }
  }

  private async attempt(): Promise<void> {
    if (this.done || this.stopped.signal.aborted || performance.now() < this.retryAt) {
      return
    }
    // No other Orca runs this profile while we hold its lock, so an absent original stays absent.
    if (!(await legacyFilePresent(this.filename))) {
      // Only the profile's owner reads its store, and reports for it.
      if (!this.ownsProfile()) {
        this.done = true
        return
      }
      const saved = await readRetirementState(this.writer)
      this.reporter.saved(saved.reported)
      if (await legacyCompanionsPresent(this.filename)) {
        // Finishing a removal cut short deletes too, so a build that keeps the file keeps these.
        if (!this.deletes) {
          this.done = true
          return this.outcome({ outcome: 'deferred', defer: 'leftover_files' })
        }
        this.leftovers = true
        await removeLeftoverLegacyCompanions(this.filename, absorbedWal(saved.retirement))
        // A WAL this store never proved absorbed stays, so the file isn't fully gone.
        if (await legacyCompanionsPresent(this.filename)) {
          this.done = true
          return this.outcome({ outcome: 'deferred', defer: 'leftover_files' })
        }
      }
      this.done = true
      return this.outcome({
        outcome: deletedBefore(saved.retirement) ? 'deleted_before' : 'absent'
      })
    }
    // None of these change while this process runs, so a refusal here waits for the next launch.
    if (this.version === null || !this.ownsProfile()) {
      this.done = true
      return
    }
    this.firstAttemptAt ??= performance.now()
    const saved = await readRetirementState(this.writer)
    this.reporter.saved(saved.reported)
    // Retirement runs on an update: the version that copied the profile, or an older one, keeps it.
    const later = laterVersion(this.version, saved.convertedBy)
    const observation = later
      ? await observeLegacySource(this.filename, this.directory, saved)
      : null
    if (!observation || this.proof.refused(saved.retirement, observation)) {
      this.done = true
      const reason = observation ? this.proof.refusalReason : undefined
      return this.outcome(
        reason
          ? {
              outcome: 'refused',
              reason,
              artifact: this.proof.refusalArtifact ?? 'unknown',
              completeness: 'partial',
              sourceBytes: observation ? sourceBytes(observation) : null
            }
          : { outcome: 'deferred', defer: later ? 'not_reconciled' : 'same_version' }
      )
    }
    this.observed = observation
    // Proven before and held: a build that keeps the file reads that instead of walking again.
    const held = heldFor(saved.retirement, observation)
    if (held && !this.deletes) {
      this.done = true
      return this.outcome(provenOutcome('proof_complete', held, observation, null, true))
    }
    await this.eligibility.present()
    await this.eligibility.check(this.filename, this.stopped.signal)
    this.proof.observe(observation)
    this.proof.resume(saved.retirement, observation)
    const started = performance.now()
    const waited = this.waits.waitedMs()
    try {
      await this.proof.run(observation)
    } finally {
      this.activeMs += performance.now() - started - (this.waits.waitedMs() - waited)
    }
    // Every early return below waits out the backoff: no helper or full-sync commit each minute.
    if (!(await legacySourceUnchanged(this.filename, this.directory, observation))) {
      return this.later()
    }
    const walked = walkedFor(this.finishedWalk, observation) ?? this.proof.walked
    this.finishedWalk = { proof: observation.proof, store: observation.store, walked }
    const proven: LegacySourceHeld = {
      version: 2,
      phase: 'held',
      layout: LEGACY_PROOF_LAYOUT,
      proof: observation.proof,
      store: observation.store,
      counts: walked.counts,
      whole: walked.whole
    }
    if (!this.deletes) {
      return this.hold(proven, observation, walked.resumed)
    }
    const recycled = await this.readers.recycleSourceReaders()
    if (!recycled) {
      return this.later()
    }
    const signal = AbortSignal.any([recycled.signal, this.stopped.signal])
    let lease: Awaited<ReturnType<typeof acquireJournalLegacyFileLock>> | undefined
    let removal: Partial<LegacyJournalRetirementOutcome> | undefined
    try {
      // One full-sync commit makes every converted row durable before the original goes.
      const destination = await legacyDestinationIdentity(journalDomainDatabasePath(this.directory))
      if (destination.main !== observation.store) {
        return this.later()
      }
      const retiring: LegacySourceRetiring = {
        version: 2,
        phase: 'retiring',
        layout: LEGACY_PROOF_LAYOUT,
        proof: observation.proof,
        store: observation.store
      }
      if (
        (await this.writer.maintain({
          kind: 'legacy-retirement-save',
          value: JSON.stringify(retiring),
          durable: true,
          destination
        })) !== true
      ) {
        throw new Error('legacy retirement commit was not acknowledged')
      }
      lease = await this.lock(this.filename, signal)
      // Checked again while held: from here no SQLite connection can open or write the original.
      if (
        !lease.held() ||
        !this.ownsProfile() ||
        !(await legacySourceUnchanged(this.filename, this.directory, observation))
      ) {
        return this.later()
      }
      this.done = await lease.retire(observation.walBytes)
      if (!this.done) {
        this.later()
      }
      removal = provenOutcome(
        this.done ? 'deleted' : 'delete_failed',
        proven,
        observation,
        this.activeMs,
        walked.resumed
      )
    } finally {
      try {
        await lease?.close()
      } finally {
        // Conversions wait on this gate; a failed helper must never keep it closed.
        this.readers.releaseSourceReaders(recycled)
      }
    }
    // Reported once the lock and the reader gate are released: reporting waits on the writer.
    if (removal) {
      await this.outcome(removal)
    }
  }

  /** The proof finished and this build keeps the file: saved, so later launches don't walk again. */
  private async hold(
    proven: LegacySourceHeld,
    observation: LegacyProofObservation & { walBytes: string },
    resumed: boolean
  ): Promise<void> {
    if (
      (await this.writer.maintain({
        kind: 'legacy-retirement-save',
        value: JSON.stringify(proven),
        durable: false
      })) !== true
    ) {
      // Reported and retried like one that threw: unsaved, the next launch would walk again.
      throw new Error('legacy retirement hold was not acknowledged')
    }
    this.done = true
    await this.outcome(provenOutcome('proof_complete', proven, observation, this.activeMs, resumed))
  }

  private outcome(fields: Partial<LegacyJournalRetirementOutcome>): Promise<void> {
    const elapsedMs =
      this.firstAttemptAt === undefined ? null : performance.now() - this.firstAttemptAt
    return this.reporter.report({ elapsedMs, ...fields })
  }

  /** Tried again after the backoff; a finished proof is never reused without its checks. */
  private later(): void {
    this.proof.forgetFinished()
    this.retryAt = performance.now() + this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, 60 * 60_000)
  }
}
