import { lstat } from 'node:fs/promises'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import { ownsOrcadProfileDirectory } from '../../orcad/instance-lock/orcad-instance-lock-hold'
import { journalDatabasePath } from './database/journal-host-database'
import {
  journalDomainDatabasePath,
  journalRunningOrcaVersion
} from './database/journal-domain-database'
import {
  legacyDestinationIdentity,
  legacyDestinationMain,
  legacyFilePresent,
  removeLeftoverLegacyCompanions
} from './journal-legacy-retirement-files'
import {
  compareAppVersions,
  isValidAppVersion
} from '../../../shared/app-lifecycle/identity/app-version'
import type { LegacySourceRetiring } from './journal-legacy-retirement-state'
import {
  readJournalLegacySourceReceipt,
  sameJournalLegacySource,
  type JournalLegacySourceReceipt
} from './database/journal-legacy-source-receipt'
import {
  acquireJournalLegacyFileLock,
  createJournalLegacyFileEligibility
} from './journal-legacy-file-lock'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import { JournalLegacyProof, type LegacyProofObservation } from './journal-legacy-proof'
import type { JournalSqlMaintenanceResult } from './journal-sql-maintenance'

type RetirementState = Extract<JournalSqlMaintenanceResult, { kind: 'legacy-retirement-state' }>
type CopiedSource = Extract<JournalLegacySourceReceipt, { disposition: 'copied-source' }>

/** Saved for a store whose original was written after its copy: it is never retired. */
const WRITTEN_AFTER_COPY = 'written-after-copy'

/** Absent means a release before this record copied the profile, which is always earlier. */
function laterVersion(running: string, convertedBy: string | null): boolean {
  return (
    isValidAppVersion(running) &&
    (convertedBy === null ||
      (isValidAppVersion(convertedBy) && compareAppVersions(running, convertedBy) > 0))
  )
}

/**
 * Deletes the original journal once this store provably holds all of it: on a later Orca version
 * than the one that copied the profile, when no older Orca wrote the original since that copy,
 * and after every chat in it converted here. Every failed check keeps the file and retries later.
 */
export class JournalLegacyRetirement {
  private readonly filename: string
  private readonly stopped = new AbortController()
  private readonly proof: JournalLegacyProof
  private diagnosed?: string
  private retryAt = 0
  private retryDelay = 60_000
  private done = false

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
    private readonly version = journalRunningOrcaVersion()
  ) {
    this.filename = journalDatabasePath(directory)
    this.proof = new JournalLegacyProof(
      writer,
      readers,
      conversions,
      boundary,
      this.stopped.signal,
      rest
    )
  }

  stop(): void {
    this.stopped.abort()
  }

  async run(): Promise<void> {
    try {
      await this.attempt()
    } catch (error) {
      this.retryAt = performance.now() + this.retryDelay
      this.retryDelay = Math.min(this.retryDelay * 2, 60 * 60_000)
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
      if (this.ownsProfile()) {
        await removeLeftoverLegacyCompanions(this.filename)
      }
      this.done = true
      return
    }
    // None of these change while this process runs, so a refusal here waits for the next launch.
    if (this.version === null || !this.ownsProfile()) {
      this.done = true
      return
    }
    const saved = await this.savedState()
    // Retirement runs on an update: the version that copied the profile, or an older one, keeps it.
    const observation = laterVersion(this.version, saved.convertedBy)
      ? await this.observe(saved)
      : null
    if (!observation || this.proof.refused(saved.retirement, observation)) {
      this.done = true
      return
    }
    await this.eligibility.present()
    await this.eligibility.check(this.filename, this.stopped.signal)
    this.proof.observe(observation)
    await this.proof.run(observation)
    this.retryDelay = 60_000
    if (!(await this.matches(observation))) {
      return
    }
    // One full-sync commit makes every converted row durable before the original goes.
    const destination = await legacyDestinationIdentity(journalDomainDatabasePath(this.directory))
    if (destination.main !== observation.store) {
      return
    }
    const retiring: LegacySourceRetiring = {
      version: 2,
      phase: 'retiring',
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
    const recycled = await this.readers.recycleSourceReaders()
    if (!recycled) {
      return
    }
    const signal = AbortSignal.any([recycled.signal, this.stopped.signal])
    let lease: Awaited<ReturnType<typeof acquireJournalLegacyFileLock>> | undefined
    try {
      lease = await this.lock(this.filename, signal)
      // Checked again while held: from here no SQLite connection can open or write the original.
      if (!lease.held() || !this.ownsProfile() || !(await this.matches(observation))) {
        return
      }
      this.done = await lease.retire(observation.walBytes)
    } finally {
      try {
        await lease?.close()
      } finally {
        // Conversions wait on this gate; a failed helper must never keep it closed.
        this.readers.releaseSourceReaders(recycled)
      }
    }
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

  /**
   * The original exactly as this store copied it, and as the last older-Orca reconcile absorbed
   * it. A write after the copy can change records, tabs and queues that no chat revision shows, so
   * such an original is kept; null keeps it.
   */
  private async observe(
    saved: RetirementState
  ): Promise<(LegacyProofObservation & { walBytes: string }) | null> {
    const current = await readJournalLegacySourceReceipt(this.filename)
    if (
      !saved.kept ||
      current.disposition !== 'copied-source' ||
      !sameJournalLegacySource(saved.receipt ?? undefined, current)
    ) {
      return null
    }
    const domain = journalDomainDatabasePath(this.directory)
    const copied = saved.copiedSource ?? (await this.recordCopiedSource(domain, current))
    if (!sameJournalLegacySource(copied, current)) {
      return null
    }
    if (await legacyFilePresent(`${this.filename}-journal`)) {
      throw new JournalLegacyRetentionError('legacy rollback journal retained')
    }
    return {
      proof: JSON.stringify(current),
      // The store file alone: its WAL is recreated on every open, which no refusal should outlive.
      store: await legacyDestinationMain(domain),
      walBytes: current.wal.kind === 'empty' ? '0' : current.wal.size
    }
  }

  /**
   * A store copied before the copy record existed: once, judge from the files whether anything
   * wrote the original after the store was created, and keep that judgment for good.
   */
  private async recordCopiedSource(domain: string, current: CopiedSource): Promise<string> {
    const created = (await lstat(domain, { bigint: true })).birthtimeNs
    const walWritten =
      current.wal.kind === 'nonempty' && current.wal.mtimeNs !== undefined
        ? BigInt(current.wal.mtimeNs)
        : 0n
    const value =
      created !== 0n && BigInt(current.main.mtimeNs) <= created && walWritten <= created
        ? JSON.stringify(current)
        : WRITTEN_AFTER_COPY
    if ((await this.writer.maintain({ kind: 'legacy-copied-source-save', value })) !== true) {
      throw new Error('legacy copy record commit was not acknowledged')
    }
    return (await this.savedState()).copiedSource ?? WRITTEN_AFTER_COPY
  }

  private async matches(observation: LegacyProofObservation): Promise<boolean> {
    const domain = journalDomainDatabasePath(this.directory)
    return (
      JSON.stringify(await readJournalLegacySourceReceipt(this.filename)) === observation.proof &&
      (await legacyDestinationMain(domain)) === observation.store
    )
  }
}
