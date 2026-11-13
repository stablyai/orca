import { randomUUID } from 'node:crypto'
import { lstat, unlink } from 'node:fs/promises'
import { ownsOrcadProfileDirectory } from '../../orcad/instance-lock/orcad-instance-lock-hold'
import { journalDatabasePath } from './database/journal-host-database'
import { journalDomainDatabasePath } from './database/journal-domain-database'
import {
  LEGACY_COMPANION_SUFFIXES as SUFFIXES,
  legacyFilePresent as filePresent,
  syncLegacyDirectory,
  removeLegacyCompanions,
  syncLegacyDestination,
  legacyDestinationIdentity,
  type LegacyCompanionManifest as Manifest,
  type LegacyDestinationIdentity
} from './journal-legacy-retirement-files'
import {
  LEGACY_RETIREMENT_WEEK,
  decodeRetirement,
  JournalLegacyGraceClock,
  type Retirement
} from './journal-legacy-retirement-state'
import {
  captureJournalLegacySourceReceipt,
  journalLegacyFileIdentity
} from './database/journal-legacy-source-receipt'
import { acquireJournalLegacyFileLock } from './journal-legacy-file-lock'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import { completeJournalLegacyProof } from './journal-legacy-source-proof'

const WEEK = LEGACY_RETIREMENT_WEEK
const SAVE_INTERVAL = 6 * 60 * 60 * 1000
const PROCESS_TOKEN = randomUUID()

/** Existing maintenance owns proof, grace and one fixed unlink per yield; failures only retain data. */
export class JournalLegacyRetirement {
  private readonly filename: string
  private readonly clock = new JournalLegacyGraceClock()
  private lastSaved = 0
  private diagnosed?: string
  private stopped = new AbortController()

  constructor(
    private readonly directory: string,
    private readonly writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<
      JournalSqlReaderPool,
      'legacyProof' | 'importState' | 'recycleSourceReaders' | 'releaseSourceReaders'
    >,
    private readonly conversions: Pick<JournalSqlConversions, 'ensure'>,
    private readonly boundary: () => Promise<boolean>,
    private readonly report: (error: unknown) => void,
    private readonly ownsProfile = () => ownsOrcadProfileDirectory(directory),
    private readonly lock = acquireJournalLegacyFileLock,
    private readonly rest: (started: number) => Promise<void> = async () => {}
  ) {
    this.filename = journalDatabasePath(directory)
  }

  stop(): void {
    if (!this.stopped.signal.aborted) {
      this.clock.pause()
      this.stopped.abort()
    }
  }

  async run(): Promise<void> {
    try {
      await this.attempt()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (this.diagnosed !== reason) {
        this.diagnosed = reason
        this.report(error)
      }
    }
  }

  async flushCredit(): Promise<void> {
    if (!this.stopped.signal.aborted) {
      return
    }
    try {
      const saved = await this.savedState()
      const state = decodeRetirement(saved.retirement)
      if (
        !state ||
        state.phase !== 'grace' ||
        state.proof !== saved.receipt ||
        !this.matches(state.proof)
      ) {
        return
      }
      const advanced = this.clock.observe(state, Date.now(), PROCESS_TOKEN)
      if (advanced.completedAt === state.completedAt && advanced.credit > state.credit) {
        await this.save(advanced, false)
      }
    } catch (error) {
      this.report(error)
    }
  }

  private async savedState() {
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

  private async save(
    state: Retirement,
    durable: boolean,
    destination?: LegacyDestinationIdentity
  ): Promise<void> {
    state.creditRevision++
    if (
      (await this.writer.maintain({
        kind: 'legacy-retirement-save',
        value: JSON.stringify(state),
        durable,
        destination
      })) !== true
    ) {
      throw new Error('legacy retirement commit was not acknowledged')
    }
    this.lastSaved = Date.now()
    this.clock.persisted(state)
  }

  private matches(proof: string): boolean {
    return JSON.stringify(captureJournalLegacySourceReceipt(this.filename)) === proof
  }

  private prove(): Promise<void> {
    return completeJournalLegacyProof(
      this.readers,
      this.conversions,
      this.writer,
      this.boundary,
      this.stopped.signal,
      this.rest
    )
  }

  private async attempt(): Promise<void> {
    if (this.stopped.signal.aborted) {
      return
    }
    const saved = await this.savedState()
    if (!saved.receipt) {
      return
    }
    const receipt = JSON.parse(saved.receipt)
    if (
      receipt.version !== 1 ||
      receipt.profileCopyInventoryVersion !== 1 ||
      receipt.disposition !== 'copied-source' ||
      receipt.wal?.kind !== 'empty'
    ) {
      return
    }
    const proof = saved.receipt
    let state = decodeRetirement(saved.retirement)
    if (state && state.proof !== saved.receipt) {
      throw new Error('legacy retirement provenance changed')
    }
    if (state?.phase === 'complete') {
      if (!(await filePresent(this.filename))) {
        return
      }
      state = { ...state, phase: 'prepared' }
    }
    if (state?.phase === 'prepared' && !(await filePresent(this.filename))) {
      await this.removeCompanions(state)
      return
    }
    if (!this.matches(proof)) {
      throw new Error('legacy source changed; retaining the original')
    }
    const now = Date.now()
    if (!state) {
      await this.prove()
      if (!this.matches(proof)) {
        throw new Error('legacy source changed during proof')
      }
      state = {
        version: 1,
        proof: saved.receipt,
        proofId: randomUUID(),
        completedAt: now,
        process: PROCESS_TOKEN,
        credit: 0,
        creditRevision: 0,
        lastWall: now,
        phase: 'grace'
      }
      await this.save(state, true)
      return
    }
    const advanced = this.clock.observe(state, now, PROCESS_TOKEN)
    if (advanced.process !== state.process || advanced.completedAt !== state.completedAt) {
      await this.prove()
      if (!this.matches(proof)) {
        return
      }
      await this.save(advanced, true)
      return
    }
    state = advanced
    if (state.credit < WEEK || state.process === PROCESS_TOKEN) {
      if (now - this.lastSaved >= SAVE_INTERVAL) {
        await this.save(state, false)
      }
      return
    }
    await this.prove()
    if (!this.ownsProfile() || !this.matches(proof)) {
      return
    }
    const recycled = await this.readers.recycleSourceReaders()
    if (!recycled) {
      return
    }
    const signal = AbortSignal.any([recycled.signal, this.stopped.signal])
    let lease: Awaited<ReturnType<typeof acquireJournalLegacyFileLock>> | undefined
    try {
      lease = await this.lock(this.filename, signal)
      const validate = () => {
        if (!lease?.held() || signal.aborted || !this.ownsProfile() || !this.matches(proof)) {
          throw new Error('legacy retirement lost exclusive ownership')
        }
      }
      validate()
      if (await filePresent(`${this.filename}-journal`)) {
        throw new Error('legacy rollback journal retained')
      }
      const manifest: Manifest = {}
      for (const suffix of SUFFIXES) {
        if (await filePresent(this.filename + suffix)) {
          const file = await lstat(this.filename + suffix)
          if (!file.isFile()) {
            throw new Error('legacy companion is not a regular file')
          }
          manifest[suffix] = journalLegacyFileIdentity(this.filename + suffix)
        }
      }
      if (manifest['-wal'] && manifest['-wal'].size !== '0') {
        throw new Error('legacy WAL still contains data')
      }
      const domain = journalDomainDatabasePath(this.directory)
      const destination = legacyDestinationIdentity(domain)
      await syncLegacyDestination(this.directory, this.filename)
      if (JSON.stringify(legacyDestinationIdentity(domain)) !== JSON.stringify(destination)) {
        throw new Error('journal destination changed during sync')
      }
      state = { ...state, phase: 'prepared', manifest }
      await this.save(state, true, destination)
      validate()
      if (JSON.stringify(legacyDestinationIdentity(domain)) !== JSON.stringify(destination)) {
        throw new Error('journal destination changed after prepare')
      }
      if (process.platform === 'win32') {
        await lease.close()
        lease = undefined
      }
      if (!this.ownsProfile() || signal.aborted || !this.matches(proof)) {
        return
      }
      await unlink(this.filename)
      await syncLegacyDirectory(this.directory)
      await lease?.close()
      lease = undefined
      this.readers.releaseSourceReaders(recycled)
      await this.removeCompanions(state)
    } finally {
      try {
        await lease?.close()
      } finally {
        this.readers.releaseSourceReaders(recycled)
      }
    }
  }

  private async removeCompanions(state: Retirement): Promise<void> {
    if (
      await removeLegacyCompanions(
        this.directory,
        this.filename,
        state.manifest,
        this.boundary,
        this.ownsProfile,
        this.stopped.signal
      )
    ) {
      await this.save({ ...state, phase: 'complete' }, true)
    }
  }
}
