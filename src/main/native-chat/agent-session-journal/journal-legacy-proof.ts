import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import {
  completeJournalLegacyProof,
  createLegacyProofFrontier
} from './journal-legacy-proof-frontier'
import {
  decodeLegacySourceProving,
  decodeLegacySourceRefusal,
  isLegacyProofLayout,
  LEGACY_PROOF_COPIES_TABLE,
  LEGACY_PROOF_HISTORICAL_LAYOUT,
  LEGACY_PROOF_LAYOUT,
  type LegacyProofLayout,
  LEGACY_SOURCE_INVENTORY,
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

  /** The walk finished this attempt; only the removal is left. */
  get finished(): boolean {
    return this.proven
  }

  /**
   * Drops a finished walk, so the next attempt resumes from what was saved and checks again what
   * can change meanwhile (compares due, failures), exactly as the next launch would.
   */
  forgetFinished(): void {
    if (this.proven) {
      this.descriptor = undefined
      this.proven = false
    }
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
      this.frontier = {
        ...createLegacyProofFrontier({ ...at.cursor, check: true }, at),
        historical: at.layout === LEGACY_PROOF_HISTORICAL_LAYOUT
      }
    }
  }

  /** What this run of the proof walked, and whether it picked up saved progress. */
  get walked(): {
    /** Null until a page finished or saved progress carried counts: nothing was measured yet. */
    counts: LegacyProofCounts | null
    resumed: boolean
    whole: boolean
  } {
    const { counts, resumed, whole, pages, copiesOnly } = this.frontier
    const measured = !copiesOnly && (pages > 0 || (resumed && whole))
    return { counts: measured ? { ...counts } : null, resumed, whole }
  }

  /** Why this original was refused, once `refused` said so. */
  get refusalReason(): LegacySourceRefusal['reason'] | undefined {
    return this.refusal?.reason
  }

  /** Which shapes builds left behind an inventory refusal saw. */
  get refusalArtifact(): LegacySourceRefusal['artifact'] {
    return this.refusal?.artifact
  }

  /** The layout this proof's progress, held and retiring records are saved under. */
  get layout(): LegacyProofLayout {
    return this.frontier.historical ? LEGACY_PROOF_HISTORICAL_LAYOUT : LEGACY_PROOF_LAYOUT
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
          ...(error.artifact ? { artifact: error.artifact } : {}),
          inventory: LEGACY_SOURCE_INVENTORY
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
      layout: this.layout,
      proof: observation.proof,
      store: observation.store,
      cursor,
      // Only counts that began at the first page are carried, so a resumed walk can say so.
      ...(this.frontier.whole ? { counts: { ...this.frontier.counts } } : {})
    }
    const saved = await this.writer.maintain({
      kind: 'legacy-retirement-save',
      value: JSON.stringify(proving),
      durable: false
    })
    // A copy converts only once the progress before it is saved.
    if (saved !== true) {
      throw new Error('legacy proof progress was not saved')
    }
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
): { cursor: LegacyProofCursor; layout: LegacyProofLayout; counts?: LegacyProofCounts } | null {
  const proving = decodeLegacySourceProving(saved)
  if (proving) {
    if (proving.proof !== observation.proof || proving.store !== observation.store) {
      return null
    }
    // Copies the reconcile keeps can sort anywhere, so their pages are always walked whole.
    return proving.cursor.table >= LEGACY_PROOF_COPIES_TABLE
      ? {
          cursor: { table: LEGACY_PROOF_COPIES_TABLE, after: null },
          layout: proving.layout,
          // Copies already converted are gone from the original's mappings, so their count stands.
          counts: proving.counts
        }
      : { cursor: proving.cursor, layout: proving.layout, counts: proving.counts }
  }
  let retiring: unknown
  try {
    retiring = saved ? JSON.parse(saved) : null
  } catch {
    return null
  }
  return typeof retiring === 'object' &&
    retiring !== null &&
    'phase' in retiring &&
    // Only a deletion cut short: a held proof is no standing permission, so a deleting build walks again.
    retiring.phase === 'retiring' &&
    'layout' in retiring &&
    isLegacyProofLayout(retiring.layout) &&
    'proof' in retiring &&
    retiring.proof === observation.proof &&
    'store' in retiring &&
    retiring.store === observation.store
    ? { cursor: { table: LEGACY_PROOF_COPIES_TABLE, after: null }, layout: retiring.layout }
    : null
}
