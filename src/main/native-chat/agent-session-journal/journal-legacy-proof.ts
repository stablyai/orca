import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import {
  completeJournalLegacyProof,
  createLegacyProofFrontier
} from './journal-legacy-proof-frontier'
import {
  decodeLegacySourceProving,
  decodeLegacySourceRefusal,
  LEGACY_PROOF_COPIES_TABLE,
  LEGACY_PROOF_LAYOUT,
  LEGACY_SOURCE_REFUSAL_POLICY,
  type LegacyProofCounts,
  type LegacySourceProving,
  type LegacySourceRefusal
} from './journal-legacy-retirement-state'
import type { LegacyProofCursor } from './journal-legacy-source-proof'
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

  /** Drops a finished walk: the next attempt resumes from what was saved and checks it again. */
  forget(): void {
    this.descriptor = undefined
  }

  /**
   * Picks up where an earlier launch's proof of this same original into this same store stopped,
   * or, after a deletion that didn't go through, at the copies it ends with. Pages already proven
   * stay proven: the original is unchanged, the store keeps what it converted and kept, and a
   * person's own edits here since supersede what it showed. What an older-Orca pass can add
   * since (compares due, failures) is checked again first, and copies are walked from the start.
   */
  resume(saved: string | null, observation: LegacyProofObservation): void {
    const fresh =
      this.frontier.pages === 0 &&
      !this.frontier.page &&
      this.frontier.cursor?.table === 0 &&
      this.frontier.cursor.after === null
    const at = fresh ? savedCursor(saved, observation) : null
    if (at) {
      this.frontier = createLegacyProofFrontier({ ...at.cursor, check: true }, at)
    }
  }

  /** What this run of the proof walked, and whether it picked up saved progress. */
  get walked(): {
    counts: LegacyProofCounts
    resumed: boolean
    whole: boolean
    fromCopies: boolean
  } {
    const { counts, resumed, whole, fromCopies } = this.frontier
    return { counts: { ...counts }, resumed, whole, fromCopies }
  }

  /** Why this original was refused, once `refused` said so. */
  get refusalReason(): LegacySourceRefusal['reason'] | undefined {
    return this.refusal?.reason
  }

  /** A shape builds left behind that the refusal saw. */
  get refusalArtifact(): LegacySourceRefusal['artifact'] {
    return this.refusal?.artifact
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
        this.frontier,
        (cursor) => this.saveProgress(observation, cursor)
      )
    } catch (error) {
      if (error instanceof JournalLegacyRetentionError && error.reason) {
        this.refusal = {
          version: 2,
          phase: 'refused',
          policy: LEGACY_SOURCE_REFUSAL_POLICY,
          proof: observation.proof,
          store: observation.store,
          reason: error.reason,
          ...(error.artifact ? { artifact: error.artifact } : {})
        }
        await this.saveRefusal()
      }
      throw error
    }
    this.proven = true
  }

  private async saveProgress(
    observation: LegacyProofObservation,
    { check: _check, ...cursor }: LegacyProofCursor
  ): Promise<void> {
    const proving: LegacySourceProving = {
      version: 2,
      phase: 'proving',
      layout: LEGACY_PROOF_LAYOUT,
      proof: observation.proof,
      store: observation.store,
      cursor,
      // Only counts that began at the first page are carried, so a resumed walk can say so.
      ...(this.frontier.whole ? { counts: { ...this.frontier.counts } } : {})
    }
    await this.writer.maintain({
      kind: 'legacy-retirement-save',
      value: JSON.stringify(proving),
      durable: false
    })
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

/** Where a saved proof of this original into this store resumes; null starts from the beginning. */
function savedCursor(
  saved: string | null,
  observation: LegacyProofObservation
): { cursor: LegacyProofCursor; counts?: LegacyProofCounts; fromCopies?: boolean } | null {
  const proving = decodeLegacySourceProving(saved)
  if (proving) {
    if (proving.proof !== observation.proof || proving.store !== observation.store) {
      return null
    }
    // Copies the reconcile keeps can sort anywhere, so their pages are always walked whole.
    return proving.cursor.table >= LEGACY_PROOF_COPIES_TABLE
      ? {
          cursor: { table: LEGACY_PROOF_COPIES_TABLE, after: null },
          // The copies are walked again from their first, so they're counted again from zero.
          counts: proving.counts && { ...proving.counts, copies: 0 }
        }
      : { cursor: proving.cursor, counts: proving.counts }
  }
  let retiring: unknown
  try {
    retiring = saved ? JSON.parse(saved) : null
  } catch {
    return null
  }
  const proven =
    typeof retiring === 'object' &&
    retiring !== null &&
    'phase' in retiring &&
    (retiring.phase === 'retiring' || retiring.phase === 'held') &&
    'layout' in retiring &&
    retiring.layout === LEGACY_PROOF_LAYOUT &&
    'proof' in retiring &&
    retiring.proof === observation.proof &&
    'store' in retiring &&
    retiring.store === observation.store
  return proven
    ? { cursor: { table: LEGACY_PROOF_COPIES_TABLE, after: null }, fromCopies: true }
    : null
}
