import {
  JournalLegacyIneligibleError,
  JournalLegacyRetentionError
} from './journal-legacy-retention-error'
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
  removeLeftoverLegacyCompanions
} from './journal-legacy-retirement-files'
import {
  compareAppVersions,
  isValidAppVersion
} from '../../../shared/app-lifecycle/identity/app-version'
import { LEGACY_PROOF_LAYOUT, type LegacySourceRetiring } from './journal-legacy-retirement-state'
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
 * Absent means a release before this record copied the profile, which is always earlier; a copy
 * made without a known version waits only for the first launch that knows its own.
 */
function laterVersion(running: string, convertedBy: string | null): boolean {
  return (
    isValidAppVersion(running) &&
    (convertedBy === null ||
      !isValidAppVersion(convertedBy) ||
      compareAppVersions(running, convertedBy) > 0)
  )
}

/** The WAL a saved retirement proved absorbed, so a removal cut short after the main file can finish. */
function absorbedWal(
  saved: string | null
): { size: string; ino?: string; mtimeNs?: string } | undefined {
  try {
    const record: unknown = saved ? JSON.parse(saved) : null
    if (!isRecord(record) || record.phase !== 'retiring' || typeof record.proof !== 'string') {
      return undefined
    }
    const proof: unknown = JSON.parse(record.proof)
    const wal = isRecord(proof) && isRecord(proof.wal) ? proof.wal : undefined
    return wal?.kind === 'nonempty' &&
      typeof wal.size === 'string' &&
      typeof wal.ino === 'string' &&
      typeof wal.mtimeNs === 'string'
      ? { size: wal.size, ino: wal.ino, mtimeNs: wal.mtimeNs }
      : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
      // Unsupported storage or file identity doesn't change while this process runs.
      this.done ||= error instanceof JournalLegacyIneligibleError
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
      if (this.ownsProfile()) {
        await removeLeftoverLegacyCompanions(
          this.filename,
          absorbedWal((await this.savedState()).retirement)
        )
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
    this.proof.resume(saved.retirement, observation)
    await this.proof.run(observation)
    // Every early return below waits out the backoff: no helper or full-sync commit each minute.
    if (!(await this.matches(observation))) {
      return this.later()
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
      this.done = await lease.retire(observation.walBytes)
      if (!this.done) {
        this.later()
      }
    } finally {
      try {
        await lease?.close()
      } finally {
        // Conversions wait on this gate; a failed helper must never keep it closed.
        this.readers.releaseSourceReaders(recycled)
      }
    }
  }

  private later(): void {
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

  /**
   * The original as the last older-Orca reconcile absorbed it, so the content proof reads what
   * this store has already taken in; null keeps the original for this attempt.
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

  private async matches(observation: LegacyProofObservation): Promise<boolean> {
    const domain = journalDomainDatabasePath(this.directory)
    return (
      JSON.stringify(await readJournalLegacySourceReceipt(this.filename)) === observation.proof &&
      (await legacyDestinationMain(domain)) === observation.store
    )
  }
}
