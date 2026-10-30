import type { JournalHostDatabase } from './journal-host-database'
import { sweepJournalOutcomePage } from './journal-outcome-cleanup'
import { journalOutcomeSource } from './journal-outcome-format'
import { readJournalSessionEpoch } from './journal-row-table'
import { JournalOutcomeConversion } from './journal-outcome-conversion'
import { JournalOutcomeRebuild } from './journal-outcome-rebuild'
import { ownJournalMaintenance, type JournalMaintenanceOwner } from './journal-maintenance'

export type JournalCatchUpStep = 'advanced' | 'current' | 'parked' | 'stale' | 'retired' | 'failed'
export type JournalCatchUpPacing = {
  work: <T>(unit: () => T) => T
  rest: () => Promise<boolean>
}

/** One maintenance owner spans conversion or cache repair, including all asynchronous reads. */
export class JournalProjectionCatchUp {
  private owner: JournalMaintenanceOwner | null = null
  private conversion: JournalOutcomeConversion | null = null
  private rebuild: JournalOutcomeRebuild | null = null
  private verify = false
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
  async load(pacing: JournalCatchUpPacing): Promise<'ready' | 'stopped'> {
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
      this.owner = ownJournalMaintenance(this.database.db, this.sessionId, this.epoch)
      if (!this.owner) {
        return 'stopped'
      }
      if (source) {
        this.rebuild = new JournalOutcomeRebuild(this.database, this.sessionId, this.epoch, source)
      } else {
        this.conversion = new JournalOutcomeConversion(this.database, this.sessionId, this.epoch)
      }
    }
    if (this.verify && this.conversion) {
      if (!(await this.conversion.verify(pacing))) {
        this.close()
        return 'stopped'
      }
      this.verify = false
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
      const step = this.conversion?.page() ?? this.rebuild?.page() ?? 'stale'
      if (step === 'verify') {
        this.verify = true
        return 'advanced'
      }
      if (step === 'current') {
        this.coverage = this.rebuild?.through ?? 0
        this.release()
        // A converted generation still needs its disposable cache built.
        return this.coverage === 0 ? 'advanced' : 'current'
      }
      if (step === 'parked' || step === 'retired') {
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
    this.conversion?.close()
    this.conversion = null
    this.rebuild?.close()
    this.rebuild = null
    this.owner?.release()
    this.owner = null
  }
}
