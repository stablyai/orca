import { JournalLegacyIneligibleError } from './journal-legacy-retention-error'
import { findOrcadProfileLock } from '../../orcad/instance-lock/orcad-instance-lock-hold'
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
import type { LegacySourceHeld, LegacySourceRetiring } from './journal-legacy-retirement-state'
import {
  acquireJournalLegacyFileLock,
  createJournalLegacyFileEligibility
} from './journal-legacy-file-lock'
import { JournalIndeterminateWriteError, type JournalSqlOwner } from './journal-sql-owner'
import {
  assertJournalRetirementPermit,
  JournalRetirementCancelledError,
  JournalRetirementRecordsPendingError
} from './journal-retirement-permit'
import {
  LegacyJournalRetirementReporter,
  LegacyJournalRetirementLaunchReport,
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
  private readonly permit = new Int32Array(new SharedArrayBuffer(4))
  private readonly writer: Pick<JournalSqlOwner, 'maintain'>
  private readonly ownsProfile: () => boolean
  private unsubscribe?: () => void
  private readonly proof: JournalLegacyProof
  private diagnosed?: string
  private retryAt = 0
  private retryDelay = 60_000
  private done = false
  private readonly launchReport = new LegacyJournalRetirementLaunchReport()
  private readonly reporter: LegacyJournalRetirementReporter
  private activeMs = 0
  private readonly waits = legacyProofWaits()
  private startedAt: number | undefined
  // What the proof read this launch, so a failed attempt still reports the file's size.
  private observed: (LegacyProofObservation & { walBytes: string }) | undefined
  // The first finished walk this launch: a retry walks only from saved progress, so counts less.
  private finishedWalk: FinishedWalk | undefined
  // Removing the side files a removal cut short left, after the main file was gone.
  private leftovers = false

  constructor(
    private readonly directory: string,
    writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<
      JournalSqlReaderPool,
      'legacyProof' | 'importState' | 'recycleSourceReaders' | 'releaseSourceReaders'
    >,
    conversions: Pick<JournalSqlConversions, 'ensure'>,
    boundary: (signal: AbortSignal) => Promise<boolean>,
    private readonly report: (error: unknown) => void,
    ownsProfile?: () => boolean,
    private readonly lock = acquireJournalLegacyFileLock,
    rest: (started: number, signal: AbortSignal) => Promise<void> = async () => {},
    private readonly eligibility = createJournalLegacyFileEligibility(),
    private readonly version = journalRunningOrcaVersion(),
    private readonly deletes = LEGACY_JOURNAL_RETIREMENT_DELETES
  ) {
    const profile = ownsProfile ? undefined : findOrcadProfileLock(directory)
    this.ownsProfile = ownsProfile ?? profile?.ownsProfile ?? (() => false)
    if (profile || ownsProfile) {
      Atomics.store(this.permit, 0, 1)
    }
    const { signal } = this.stopped
    const authority = { permit: this.permit, signal }
    const canDeliver = () => Atomics.load(this.permit, 0) === 1
    this.writer = {
      maintain: async (operation) => {
        assertJournalRetirementPermit(this.permit)
        return writer.maintain(operation, this.permit)
      }
    }
    this.filename = journalDatabasePath(directory)
    this.reporter = new LegacyJournalRetirementReporter(this.writer, version, deletes, canDeliver)
    this.proof = new JournalLegacyProof(
      this.writer,
      readers,
      // A conversion can wait for idle inside, so active time leaves conversions out entirely.
      { ensure: this.waits.timed((id, foreground) => conversions.ensure(id, foreground, authority)) },
      this.waits.timed(() => boundary(signal)),
      signal,
      this.waits.timed((started) => rest(started, signal))
    )
    this.unsubscribe = profile?.onEnd(this.permit, () => this.stop())
  }

  stop(): void {
    if (!this.stopped.signal.aborted) {
      Atomics.store(this.permit, 0, 0)
      this.unsubscribe?.()
      this.unsubscribe = undefined
      this.stopped.abort(new JournalRetirementCancelledError())
    }
  }

  async run(): Promise<void> {
    if (this.stopped.signal.aborted) {
      return
    }
    try {
      if (this.done) {
        // Rides the maintenance tick: a report the usage client refused goes once it would take it.
        return await this.reporter.resendUnsent()
      }
      if (performance.now() < this.retryAt || this.launchReport.reported) {
        return
      }
      let present: boolean
      try {
        present = await legacyFilePresent(this.filename)
      } catch (error) {
        const admitted = !this.stopped.signal.aborted && this.ownsProfile()
        await this.failed(error, admitted)
        return
      }
      this.stopped.signal.throwIfAborted()
      await this.attempt(present)
    } catch (error) {
      await this.failed(error)
    }
  }

  private async failed(error: unknown, deliver = true): Promise<void> {
    if (error instanceof JournalRetirementRecordsPendingError) {
      this.later()
      return
    }
    if (error instanceof JournalRetirementCancelledError) {
      return
    }
    if (this.stopped.signal.aborted) {
      if (error instanceof JournalIndeterminateWriteError) {
        this.diagnose(error)
      }
      return
    }
    // Unsupported storage or file identity doesn't change while this process runs.
    if (error instanceof JournalLegacyIneligibleError && !this.done) {
      this.done = true
      await this.outcome({ outcome: 'deferred', defer: 'unsupported_storage' }, deliver).catch(() => {})
    } else if (this.leftovers) {
      await this.outcome({ outcome: 'deferred', defer: 'leftover_files' }, deliver).catch(() => {})
    } else {
      const failed = legacyProofFailureOutcome(
        error,
        walkedFor(this.finishedWalk, this.observed) ?? this.proof.walked,
        this.proof.finished && this.deletes
      )
      failed.sourceBytes = this.observed ? sourceBytes(this.observed) : null
      failed.activeMs = this.activeMs
      await this.outcome(failed, deliver).catch(() => {})
    }
    this.later()
    this.diagnose(error)
  }

  private diagnose(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (this.diagnosed !== message) {
      this.diagnosed = message
      this.report(error)
    }
  }

  private async attempt(present: boolean): Promise<void> {
    const { signal } = this.stopped
    // Main skips ownership only when the original is present and the version is unknown.
    if ((!present || this.version !== null) && !this.ownsProfile()) {
      signal.throwIfAborted()
      return this.launchReport.defer('not_owner', this.deletes)
    }
    // No other Orca runs this profile while we hold its lock, so an absent original stays absent.
    if (!present) {
      const { reported, retirement } = await readRetirementState(this.writer)
      signal.throwIfAborted()
      this.reporter.saved(reported)
      const companions = await legacyCompanionsPresent(this.filename)
      signal.throwIfAborted()
      if (companions) {
        // Finishing a removal cut short deletes too, so a build that keeps the file keeps these.
        if (!this.deletes) {
          this.done = true
          return this.outcome({ outcome: 'deferred', defer: 'leftover_files' })
        }
        this.leftovers = true
        await removeLeftoverLegacyCompanions(this.filename, absorbedWal(retirement))
        signal.throwIfAborted()
        // A WAL this store never proved absorbed stays, so the file isn't fully gone.
        if (await legacyCompanionsPresent(this.filename)) {
          this.done = true
          return this.outcome({ outcome: 'deferred', defer: 'leftover_files' })
        }
      }
      this.done = true
      return this.outcome({ outcome: deletedBefore(retirement) ? 'deleted_before' : 'absent' })
    }
    if (this.version === null) {
      return this.launchReport.defer('no_version', this.deletes, () => Atomics.load(this.permit, 0) === 1)
    }
    this.startedAt ??= performance.now()
    const saved = await readRetirementState(this.writer)
    signal.throwIfAborted()
    this.reporter.saved(saved.reported)
    // Retirement runs on an update: the version that copied the profile, or an older one, keeps it.
    const later = laterVersion(this.version, saved.convertedBy)
    const observation = later
      ? await observeLegacySource(this.filename, this.directory, saved)
      : null
    signal.throwIfAborted()
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
    signal.throwIfAborted()
    await this.eligibility.check(this.filename, signal)
    signal.throwIfAborted()
    this.proof.observe(observation)
    this.proof.resume(saved.retirement, observation)
    const started = performance.now()
    const waited = this.waits.waitedMs()
    try {
      await this.proof.run(observation)
    } finally {
      this.activeMs += performance.now() - started - (this.waits.waitedMs() - waited)
    }
    signal.throwIfAborted()
    // Every early return below waits out the backoff: no helper or full-sync commit each minute.
    const unchanged = await legacySourceUnchanged(this.filename, this.directory, observation)
    signal.throwIfAborted()
    if (!unchanged) {
      return this.later()
    }
    const walked = walkedFor(this.finishedWalk, observation) ?? this.proof.walked
    this.finishedWalk = { proof: observation.proof, store: observation.store, walked }
    const proven: LegacySourceHeld = {
      version: 2,
      phase: 'held',
      layout: this.proof.layout,
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
    const removalSignal = AbortSignal.any([recycled.signal, signal])
    let lease: Awaited<ReturnType<typeof acquireJournalLegacyFileLock>> | undefined
    let removal: Partial<LegacyJournalRetirementOutcome>
    try {
      signal.throwIfAborted()
      // One full-sync commit makes every converted row durable before the original goes.
      const destination = await legacyDestinationIdentity(journalDomainDatabasePath(this.directory))
      signal.throwIfAborted()
      if (destination.main !== observation.store) {
        return this.later()
      }
      const retiring: LegacySourceRetiring = {
        version: 2,
        phase: 'retiring',
        layout: this.proof.layout,
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
      signal.throwIfAborted()
      lease = await this.lock(this.filename, removalSignal)
      signal.throwIfAborted()
      // Checked again while held: from here no SQLite connection can open or write the original.
      if (
        !lease.held() ||
        !this.ownsProfile() ||
        !(await legacySourceUnchanged(this.filename, this.directory, observation))
      ) {
        return this.later()
      }
      signal.throwIfAborted()
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
    await this.outcome(removal)
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

  private outcome(fields: Partial<LegacyJournalRetirementOutcome>, deliver = true): Promise<void> {
    this.stopped.signal.throwIfAborted()
    const elapsedMs = this.startedAt === undefined ? null : performance.now() - this.startedAt
    return this.reporter.report({ elapsedMs, ...fields }, deliver)
  }

  /** Tried again after the backoff; a finished proof is never reused without its checks. */
  private later(): void {
    this.proof.forgetFinished()
    this.retryAt = performance.now() + this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, 60 * 60_000)
  }
}
