import { JournalLegacyIneligibleError } from './journal-legacy-retention-error'
import { ownsOrcadProfileDirectory } from '../../orcad/instance-lock/orcad-instance-lock-hold'
import {
  journalDatabasePath,
  journalDomainDatabasePath,
  journalRunningOrcaVersion
} from './database/journal-host-database'
import {
  legacyDestinationIdentity,
  legacyDestinationMain,
  legacyFilePresent,
  legacyCompanionsPresent,
  removeLeftoverLegacyCompanions
} from './journal-legacy-retirement-files'
import {
  LEGACY_PROOF_LAYOUT,
  type LegacySourceHeld,
  type LegacySourceRetiring
} from './journal-legacy-retirement-state'
import { readJournalLegacySourceReceipt } from './database/journal-legacy-source-receipt'
import {
  acquireJournalLegacyFileLock,
  createJournalLegacyFileEligibility
} from './journal-legacy-file-lock'
import type { JournalSqlOwner } from './journal-sql-owner'
import {
  LegacyJournalRetirementReporter,
  legacyProofFailureOutcome,
  legacyJournalRetirementMode,
  type LegacyJournalRetirementMode,
  type LegacyJournalRetirementOutcome
} from './journal-legacy-retirement-outcome'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import { JournalLegacyProof, type LegacyProofObservation } from './journal-legacy-proof'
import {
  absorbedWal,
  observeLegacySource,
  heldFor,
  laterVersion,
  legacyProofWaits,
  provenOutcome,
  sourceBytes
} from './journal-legacy-retirement-held'
import type { JournalSqlMaintenanceResult } from './journal-sql-maintenance'

type RetirementState = Extract<JournalSqlMaintenanceResult, { kind: 'legacy-retirement-state' }>

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
  private policy: LegacyJournalRetirementMode = { mode: 'report', revision: 0 }
  private readonly reporter: LegacyJournalRetirementReporter
  private activeMs = 0
  private readonly waits = legacyProofWaits()
  private firstAttemptAt: number | undefined

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
    private readonly mode = legacyJournalRetirementMode
  ) {
    this.filename = journalDatabasePath(directory)
    this.reporter = new LegacyJournalRetirementReporter(writer, version)
    this.proof = new JournalLegacyProof(
      writer,
      readers,
      conversions,
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
      } else {
        const removing = this.proof.finished && this.policy.mode === 'enforce'
        const failed = legacyProofFailureOutcome(error, this.proof.walked, removing)
        await this.outcome({ ...failed, activeMs: this.activeMs }).catch(() => {})
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
      // Finishing a removal cut short deletes too, so it needs the same permission.
      if (this.ownsProfile() && (await legacyCompanionsPresent(this.filename))) {
        // Asked last, right before the unlink: the saved-state read can take a while.
        const saved = await this.savedState()
        const absorbed = absorbedWal(saved.retirement)
        if (!(await this.enforced())) {
          this.reporter.saved(saved.reported)
          this.later()
          return this.outcome({ outcome: 'deferred', defer: 'leftover_files' })
        }
        await removeLeftoverLegacyCompanions(this.filename, absorbed)
      }
      this.done = true
      return
    }
    // None of these change while this process runs, so a refusal here waits for the next launch.
    if (this.version === null || !this.ownsProfile()) {
      this.done = true
      return
    }
    this.firstAttemptAt ??= performance.now()
    const saved = await this.savedState()
    this.reporter.saved(saved.reported)
    this.policy = await this.mode()
    // Off: no proof and no deletion; chats still convert as they are opened or idle.
    if (this.policy.mode === 'off') {
      this.done = true
      return this.outcome({ outcome: 'off' })
    }
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
              artifact: this.proof.refusalArtifact ?? 'none',
              completeness: 'partial',
              sourceBytes: observation ? sourceBytes(observation) : null
            }
          : { outcome: 'deferred', defer: later ? 'not_reconciled' : 'same_version' }
      )
    }
    // Proven before and held: report mode reads that instead of walking every chat again.
    const held = heldFor(saved.retirement, observation)
    if (held && this.policy.mode !== 'enforce') {
      // Asked again on the backoff: a policy downloaded later this launch can still allow it.
      this.later()
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
    if (!(await this.matches(observation))) {
      return this.later()
    }
    const walked = this.proof.walked
    const proven: LegacySourceHeld = {
      version: 2,
      phase: 'held',
      layout: LEGACY_PROOF_LAYOUT,
      proof: observation.proof,
      store: observation.store,
      counts: held && walked.fromCopies ? held.counts : walked.counts,
      whole: held && walked.fromCopies ? held.whole : walked.whole
    }
    // Deletion needs a fresh permission, asked again before each step that can't be undone.
    if (!(await this.enforced())) {
      return this.hold(proven, observation)
    }
    const recycled = await this.readers.recycleSourceReaders()
    if (!recycled) {
      return this.later()
    }
    const signal = AbortSignal.any([recycled.signal, this.stopped.signal])
    let lease: Awaited<ReturnType<typeof acquireJournalLegacyFileLock>> | undefined
    try {
      // One full-sync commit makes every converted row durable before the original goes.
      const destination = await legacyDestinationIdentity(journalDomainDatabasePath(this.directory))
      if (destination.main !== observation.store) {
        return this.later()
      }
      if (!(await this.enforced())) {
        return await this.hold(proven, observation)
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
      if (!lease.held() || !this.ownsProfile() || !(await this.matches(observation))) {
        return this.later()
      }
      if (!(await this.enforced())) {
        return await this.hold(proven, observation)
      }
      this.done = await lease.retire(observation.walBytes)
      if (!this.done) {
        this.later()
      }
      await this.outcome(
        provenOutcome(
          this.done ? 'deleted' : 'delete_failed',
          proven,
          observation,
          this.activeMs,
          this.proof.walked.resumed
        )
      )
    } finally {
      try {
        await lease?.close()
      } finally {
        // Conversions wait on this gate; a failed helper must never keep it closed.
        this.readers.releaseSourceReaders(recycled)
      }
    }
  }

  private async enforced(): Promise<boolean> {
    this.policy = await this.mode()
    return this.policy.mode === 'enforce'
  }

  /** The proof finished and the policy keeps the file: saved, so later launches don't walk again. */
  private async hold(
    proven: LegacySourceHeld,
    observation: LegacyProofObservation & { walBytes: string }
  ): Promise<void> {
    await this.writer.maintain({
      kind: 'legacy-retirement-save',
      value: JSON.stringify(proven),
      durable: false
    })
    this.later()
    await this.outcome(
      provenOutcome('proof_complete', proven, observation, this.activeMs, this.proof.walked.resumed)
    )
  }

  private outcome(fields: Partial<LegacyJournalRetirementOutcome>): Promise<void> {
    const elapsedMs =
      this.firstAttemptAt === undefined ? null : performance.now() - this.firstAttemptAt
    return this.reporter.report({ elapsedMs, ...fields }, this.policy)
  }

  /** Tried again after the backoff; a finished proof is never reused without its checks. */
  private later(): void {
    this.proof.forgetFinished()
    this.retryAt = performance.now() + this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, 60 * 60_000)
  }

  private async savedState(): Promise<RetirementState> {
    const saved = await this.writer.maintain({ kind: 'legacy-retirement-state' })
    if (
      !saved ||
      typeof saved !== 'object' ||
      !('kind' in saved) ||
      saved.kind !== 'legacy-retirement-state'
    ) {
      throw new Error('legacy retirement state is unavailable')
    }
    return saved
  }

  private async matches(observation: LegacyProofObservation): Promise<boolean> {
    const domain = journalDomainDatabasePath(this.directory)
    return (
      JSON.stringify(await readJournalLegacySourceReceipt(this.filename)) === observation.proof &&
      (await legacyDestinationMain(domain)) === observation.store
    )
  }
}
