import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import {
  completeJournalLegacyProof,
  createLegacyProofFrontier
} from './journal-legacy-proof-frontier'
import {
  decodeLegacySourceRefusal,
  LEGACY_SOURCE_REFUSAL_POLICY,
  type LegacySourceRefusal
} from './journal-legacy-retirement-state'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'

/** The original as its receipt shows it, and the store the proof converts into. */
export type LegacyProofObservation = {
  proof: string
  store: string
}

/** One observation owns verified work, a refusal and pending conversion progress. */
export class JournalLegacyProof {
  private descriptor?: string
  private refusal?: LegacySourceRefusal
  private refusalSaved = false
  private proven = false
  private frontier = createLegacyProofFrontier()

  constructor(
    private readonly writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<JournalSqlReaderPool, 'legacyProof' | 'importState'>,
    private readonly conversions: Pick<JournalSqlConversions, 'ensure'>,
    private readonly boundary: () => Promise<boolean>,
    private readonly signal: AbortSignal,
    private readonly rest: (started: number) => Promise<void>
  ) {}

  /** A changed original or store discards progress; the same one keeps it across attempts. */
  observe(observation: LegacyProofObservation): void {
    const descriptor = `${observation.proof}\n${observation.store}`
    if (descriptor !== this.descriptor) {
      this.descriptor = descriptor
      this.refusal = undefined
      this.refusalSaved = this.proven = false
      this.frontier = createLegacyProofFrontier()
    }
  }

  /** True when this exact original was refused before; the proof isn't run again for it. */
  refused(saved: string | null, observation: LegacyProofObservation): boolean {
    // An unsaved refusal proves again, which saves it; only a saved one ends this process's attempts.
    if (this.refusal) {
      return this.refusalSaved
    }
    const refusal = decodeLegacySourceRefusal(saved)
    if (!refusal || refusal.proof !== observation.proof || refusal.store !== observation.store) {
      return false
    }
    this.refusal = refusal
    this.refusalSaved = true
    return true
  }

  async run(observation: LegacyProofObservation): Promise<void> {
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
          version: 2,
          phase: 'refused',
          policy: LEGACY_SOURCE_REFUSAL_POLICY,
          proof: observation.proof,
          store: observation.store,
          reason: error.reason
        }
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
