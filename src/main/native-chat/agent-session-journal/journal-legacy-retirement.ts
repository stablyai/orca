import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import { randomUUID } from 'node:crypto'
import { ownsOrcadProfileDirectory } from '../../orcad/instance-lock/orcad-instance-lock-hold'
import { journalDatabasePath } from './database/journal-host-database'
import {
  legacyFilePresent as filePresent,
  removeLegacyCompanions,
  retireJournalLegacyMain,
  type LegacyDestinationIdentity
} from './journal-legacy-retirement-files'
import {
  LEGACY_RETIREMENT_WEEK,
  decodeRetirement,
  JournalLegacyGraceClock,
  type Retirement
} from './journal-legacy-retirement-state'
import { readJournalLegacySourceReceipt } from './database/journal-legacy-source-receipt'
import {
  acquireJournalLegacyFileLock,
  createJournalLegacyFileEligibility
} from './journal-legacy-file-lock'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import { JournalLegacyProof } from './journal-legacy-proof'

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
  private excluded = false
  private completeAbsent = false
  private readonly proof: JournalLegacyProof
  private retryAt = 0
  private retryDelay = 60_000

  constructor(
    private readonly directory: string,
    private readonly writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<
      JournalSqlReaderPool,
      'legacyProof' | 'importState' | 'recycleSourceReaders' | 'releaseSourceReaders'
    >,
    conversions: Pick<JournalSqlConversions, 'ensure'>,
    private readonly boundary: () => Promise<boolean>,
    private readonly report: (error: unknown) => void,
    private readonly ownsProfile = () => ownsOrcadProfileDirectory(directory),
    private readonly lock = acquireJournalLegacyFileLock,
    rest: (started: number) => Promise<void> = async () => {},
    private readonly eligibility = createJournalLegacyFileEligibility()
  ) {
    this.filename = journalDatabasePath(directory)
    this.proof = new JournalLegacyProof(
      directory,
      writer,
      readers,
      conversions,
      boundary,
      this.stopped.signal,
      rest,
      eligibility
    )
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
      this.retryAt = performance.now() + this.retryDelay
      this.retryDelay = Math.min(this.retryDelay * 2, 60 * 60_000)
      const reason = error instanceof Error ? error.message : String(error)
      if (this.diagnosed !== reason) {
        this.diagnosed = reason
        this.report(error)
      }
    }
  }

  async flushCredit(): Promise<void> {
    if (
      !this.stopped.signal.aborted ||
      this.excluded ||
      this.completeAbsent ||
      this.proof.terminal
    ) {
      return
    }
    try {
      const saved = await this.savedState()
      const state = decodeRetirement(saved.retirement)
      if (
        !state ||
        state.phase !== 'grace' ||
        state.proof !== saved.receipt ||
        !(await this.matches(state.proof))
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

  private async matches(proof: string): Promise<boolean> {
    return JSON.stringify(await readJournalLegacySourceReceipt(this.filename)) === proof
  }

  private async attempt(): Promise<void> {
    if (this.stopped.signal.aborted || performance.now() < this.retryAt) {
      return
    }
    if (this.excluded) {
      return
    }
    if (this.completeAbsent) {
      if (!(await filePresent(this.filename))) {
        return
      }
      this.completeAbsent = false
    }
    if (await this.proof.retained()) {
      return
    }
    const saved = await this.savedState()
    if (!saved.receipt) {
      this.excluded = true
      return
    }
    const receipt = JSON.parse(saved.receipt)
    if (
      receipt.version !== 1 ||
      receipt.profileCopyInventoryVersion !== 1 ||
      receipt.disposition !== 'copied-source' ||
      receipt.wal?.kind !== 'empty'
    ) {
      this.excluded = true
      return
    }
    const proof = saved.receipt
    let state = decodeRetirement(saved.retirement)
    if (state && state.proof !== proof) {
      throw new JournalLegacyRetentionError('legacy retirement provenance changed')
    }
    if (state?.phase === 'complete') {
      if (!(await filePresent(this.filename))) {
        this.completeAbsent = true
        return
      }
      state = { ...state, phase: 'prepared' }
    }
    if (state?.phase === 'prepared' && !(await filePresent(this.filename))) {
      await this.removeCompanions(state)
      return
    }
    const observation = await this.proof.observe(proof)
    const { observed } = observation
    if (this.proof.restore(saved.retirement, observation)) {
      return
    }
    if (observed !== proof) {
      throw new JournalLegacyRetentionError('legacy source no longer matches its copy receipt')
    }
    if (!this.ownsProfile()) {
      return
    }
    await this.eligibility.present()
    if (await filePresent(`${this.filename}-journal`)) {
      throw new JournalLegacyRetentionError('legacy rollback journal retained')
    }
    await this.proof.checkEligibility()
    const now = Date.now()
    if (!state) {
      await this.proof.run(observation, state)
      this.retryDelay = 60_000
      if (!(await this.matches(proof))) {
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
      await this.proof.run(observation, state, true)
      this.retryDelay = 60_000
      if (!(await this.matches(proof))) {
        return
      }
      await this.save(advanced, true)
      this.proof.restamped()
      return
    }
    state = advanced
    if (state.credit < WEEK || state.process === PROCESS_TOKEN) {
      if (now - this.lastSaved >= SAVE_INTERVAL) {
        await this.save(state, false)
      }
      return
    }
    await this.proof.run(observation, state)
    this.retryDelay = 60_000
    if (!(await this.matches(proof)) || !this.ownsProfile()) {
      return
    }
    await this.eligibility.present()
    const recycled = await this.readers.recycleSourceReaders()
    if (!recycled) {
      return
    }
    const signal = AbortSignal.any([recycled.signal, this.stopped.signal])
    let prepared = state
    try {
      const removed = await retireJournalLegacyMain(
        this.directory,
        this.filename,
        signal,
        this.ownsProfile,
        () => this.matches(proof),
        this.lock,
        async (manifest, destination) => {
          prepared = { ...prepared, phase: 'prepared', manifest }
          await this.save(prepared, true, destination)
        }
      )
      if (removed) {
        this.readers.releaseSourceReaders(recycled)
        await this.removeCompanions(prepared)
      }
    } finally {
      this.readers.releaseSourceReaders(recycled)
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
      this.completeAbsent = true
    }
  }
}
