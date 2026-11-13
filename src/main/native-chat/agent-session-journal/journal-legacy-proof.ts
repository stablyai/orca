import {
  JournalLegacyRetentionError,
  JournalLegacyIneligibleError
} from './journal-legacy-retention-error'
import {
  completeJournalLegacyProof,
  createLegacyProofFrontier
} from './journal-legacy-proof-frontier'
import {
  decodeLegacySourceRefusal,
  type LegacySourceRefusal,
  type Retirement
} from './journal-legacy-retirement-state'
import { journalDatabasePath } from './database/journal-host-database'
import { journalDomainDatabasePath } from './database/journal-domain-database'
import { readJournalLegacySourceReceipt } from './database/journal-legacy-source-receipt'
import { legacyDestinationMain } from './journal-legacy-retirement-files'
import type { createJournalLegacyFileEligibility } from './journal-legacy-file-lock'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'

type Observation = { proof: string; observed: string; destination: string }

/** One descriptor owns verified work, negative evidence and pending conversion progress. */
export class JournalLegacyProof {
  private descriptor?: string
  private receipt = ''
  private refusal?: LegacySourceRefusal
  private refusalSaved = false
  private ineligible = false
  private eligible = false
  private proven = false
  private restamping = false
  private frontier = createLegacyProofFrontier()

  constructor(
    private readonly directory: string,
    private readonly writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<JournalSqlReaderPool, 'legacyProof' | 'importState'>,
    private readonly conversions: Pick<JournalSqlConversions, 'ensure'>,
    private readonly boundary: () => Promise<boolean>,
    private readonly signal: AbortSignal,
    private readonly rest: (started: number) => Promise<void>,
    private readonly eligibility: ReturnType<typeof createJournalLegacyFileEligibility>
  ) {}

  get terminal(): boolean {
    return !!this.refusal || this.ineligible
  }

  async retained(): Promise<boolean> {
    if (!this.terminal) {
      return false
    }
    await this.observe(this.receipt)
    if (!this.terminal) {
      return false
    }
    await this.saveRefusal()
    return true
  }

  async observe(proof: string): Promise<Observation> {
    const observed = JSON.stringify(
      await readJournalLegacySourceReceipt(journalDatabasePath(this.directory))
    )
    const destination = await legacyDestinationMain(journalDomainDatabasePath(this.directory))
    const descriptor = `${proof}\n${observed}\n${destination}`
    if (descriptor !== this.descriptor) {
      this.descriptor = descriptor
      this.receipt = proof
      this.refusal = undefined
      this.refusalSaved = this.ineligible = this.eligible = this.proven = this.restamping = false
      this.frontier = createLegacyProofFrontier()
    }
    return { proof, observed, destination }
  }

  restore(value: string | null, observation: Observation): boolean {
    const refusal = decodeLegacySourceRefusal(value)
    if (
      !refusal ||
      refusal.proof !== observation.proof ||
      refusal.observed !== observation.observed ||
      refusal.destination !== observation.destination
    ) {
      return false
    }
    this.refusal = refusal
    this.refusalSaved = true
    return true
  }

  async checkEligibility(): Promise<void> {
    if (this.eligible) {
      return
    }
    try {
      await this.eligibility.check(journalDatabasePath(this.directory), this.signal)
    } catch (error) {
      this.ineligible = error instanceof JournalLegacyIneligibleError
      throw error
    }
    this.eligible = true
  }

  restamped(): void {
    this.restamping = false
  }

  async run(observation: Observation, state: Retirement | null, fresh = false): Promise<void> {
    if (fresh && !this.restamping) {
      this.proven = false
      this.frontier = createLegacyProofFrontier()
      this.restamping = true
    }
    if (this.proven) {
      return
    }
    try {
      await completeJournalLegacyProof(
        this.readers,
        this.conversions,
        this.writer,
        this.boundary,
        this.signal,
        this.rest,
        this.frontier
      )
    } catch (error) {
      if (error instanceof JournalLegacyRetentionError && error.reason) {
        this.refusal = {
          version: 1,
          phase: 'refused',
          policy: 1,
          proof: observation.proof,
          observed: observation.observed,
          destination: observation.destination,
          reason: error.reason
        }
        // Partial unlink still owes its original manifest, even when a later proof refuses.
        this.refusalSaved = state?.phase === 'prepared' || state?.phase === 'complete'
        await this.saveRefusal()
      }
      throw error
    }
    this.proven = true
  }

  private async saveRefusal(): Promise<void> {
    if (!this.refusal || this.refusalSaved) {
      return
    }
    if (
      (await this.writer.maintain({
        kind: 'legacy-retirement-save',
        value: JSON.stringify(this.refusal),
        durable: false
      })) !== true
    ) {
      throw new Error('legacy refusal commit was not acknowledged')
    }
    this.refusalSaved = true
  }
}
