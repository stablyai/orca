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
  legacyFilePresent,
  removeLeftoverLegacyCompanions
} from './journal-legacy-retirement-files'
import type { LegacySourceRetiring } from './journal-legacy-retirement-state'
import {
  readJournalLegacySourceReceipt,
  sameJournalLegacySource
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
    // Retirement runs on an update: the version that copied the profile keeps the original.
    const observation = saved.convertedBy === this.version ? null : await this.observe(saved)
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
    const retiring: LegacySourceRetiring = {
      version: 2,
      phase: 'retiring',
      proof: observation.proof,
      destination: observation.destination
    }
    if (
      (await this.writer.maintain({
        kind: 'legacy-retirement-save',
        value: JSON.stringify(retiring),
        durable: true,
        destination: JSON.parse(observation.destination)
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
      this.done = await lease.retire()
    } finally {
      await lease?.close()
      this.readers.releaseSourceReaders(recycled)
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
   * The original as the last older-Orca reconcile absorbed it, never written since this store
   * copied it. A write after the copy can change records, tabs and queues that no chat revision
   * shows, so such an original is kept; null keeps it for this attempt.
   */
  private async observe(saved: RetirementState): Promise<LegacyProofObservation | null> {
    const current = await readJournalLegacySourceReceipt(this.filename)
    if (
      !saved.kept ||
      current.disposition !== 'copied-source' ||
      current.wal.kind !== 'empty' ||
      !sameJournalLegacySource(saved.receipt ?? undefined, current)
    ) {
      return null
    }
    const domain = journalDomainDatabasePath(this.directory)
    const copied = (await lstat(domain, { bigint: true })).birthtimeNs
    if (copied === 0n || BigInt(current.main.mtimeNs) > copied) {
      return null
    }
    if (await legacyFilePresent(`${this.filename}-journal`)) {
      throw new JournalLegacyRetentionError('legacy rollback journal retained')
    }
    return {
      proof: JSON.stringify(current),
      destination: JSON.stringify(await legacyDestinationIdentity(domain))
    }
  }

  private async matches(observation: LegacyProofObservation): Promise<boolean> {
    const domain = journalDomainDatabasePath(this.directory)
    return (
      JSON.stringify(await readJournalLegacySourceReceipt(this.filename)) === observation.proof &&
      JSON.stringify(await legacyDestinationIdentity(domain)) === observation.destination
    )
  }
}
