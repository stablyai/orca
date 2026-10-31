import type { JournalHostDatabase } from './journal-host-database'
import { sweepJournalOutcomePage } from './journal-outcome-cleanup'
import { journalOutcomeSource } from './journal-outcome-format'
import { readJournalSessionEpoch } from './journal-row-table'
import { JournalOutcomeRebuild } from './journal-outcome-rebuild'
import { ownJournalMaintenance, type JournalMaintenanceOwner } from './journal-maintenance'

export type JournalCatchUpStep = 'advanced' | 'current' | 'stale' | 'retired' | 'failed'
export type JournalCatchUpPacing = {
  work: <T>(unit: () => T) => T
  rest: () => Promise<boolean>
}

/** One maintenance owner spans a cache rebuild, including all asynchronous reads. Only a chat whose
 * epoch holds outcome records alone has a cache; an input prefix keeps main's open path. */
export class JournalProjectionCatchUp {
  private owner: JournalMaintenanceOwner | null = null
  private rebuild: JournalOutcomeRebuild | null = null
  private disposed = false
  private coverage = 0
  /** Why the last page returned 'failed'; the runner parks content failures and backs off others. */
  failure: unknown = null

  constructor(
    private readonly database: JournalHostDatabase,
    readonly sessionId: string,
    readonly epoch: string
  ) {}

  get through(): number {
    return this.coverage
  }

  /** 'stopped' means this chat cannot proceed now (owner held, epoch changed, closing). */
  load(pacing: JournalCatchUpPacing): 'ready' | 'stopped' {
    if (this.disposed || this.database.isClosed) {
      return 'stopped'
    }
    if (!this.owner) {
      const source = pacing.work(() =>
        journalOutcomeSource(this.database.db, this.sessionId, this.epoch)
      )
      if (pacing.work(() => sweepJournalOutcomePage(this.database))) {
        return 'ready'
      }
      if (!source || source.prefix > 0) {
        return 'stopped'
      }
      this.owner = ownJournalMaintenance(this.database.db, this.sessionId, this.epoch)
      if (!this.owner) {
        return 'stopped'
      }
      this.rebuild = new JournalOutcomeRebuild(this.database, this.sessionId, this.epoch, source)
    }
    return 'ready'
  }

  page(): JournalCatchUpStep {
    if (this.disposed || this.database.isClosed || this.database.readOnly) {
      this.close()
      return 'retired'
    }
    try {
      if (readJournalSessionEpoch(this.database.db, this.sessionId) !== this.epoch) {
        this.close()
        return 'retired'
      }
      const step = this.rebuild?.page() ?? 'stale'
      if (step === 'current') {
        this.coverage = this.rebuild?.through ?? 0
        this.release()
      } else if (step === 'retired') {
        this.close()
      }
      return step
    } catch (error) {
      this.failure = error
      this.close()
      return 'failed'
    }
  }

  close(): void {
    this.disposed = true
    this.release()
  }

  private release(): void {
    this.rebuild?.close()
    this.rebuild = null
    this.owner?.release()
    this.owner = null
  }
}
