import { getWorkerTerminalAutoReleaseScheduler } from '../terminal-authority/release/worker-terminal-auto-release-scheduler'
import { OrchestrationDb } from './orchestration-db'
import { committedHandBackTypes, type MailHandBack } from './messages/helper-mailbox-hand-back'
import { existsSync } from 'node:fs'
import { closeOrphanedTerminalApprovals } from '../workers/approvals/terminal-approval-orphans'
import { scheduleWorkerOutputCopyRemoval } from './worker-terminal/worker-output-copy-removal'
import { OrcaRuntimeWithAutomationApiOperations } from '../../workspaces/persisted-surfaces/automation-api-operations'

export abstract class RuntimeOrchestrationDatabaseAccess extends OrcaRuntimeWithAutomationApiOperations {
  abstract ensureOrchestrationFederationRelay(
    runId?: string,
    options?: { keepAwake?: boolean }
  ): void

  protected abstract scheduleRestoredMessageRepoints(): void

  /** Mail a worker left unread when it reported before a restart still continues it. */
  protected abstract continueRestoredWorkerMail(db: OrchestrationDb): void

  // Defer until userData is final; tests can inject an in-memory DB.
  getOrchestrationDb(): OrchestrationDb {
    if (!this._orchestrationDb) {
      this._orchestrationDb = new OrchestrationDb(this.orchestrationDbPath())
      this.bindMailHandBack(this._orchestrationDb)
      this.bindCrewChanges(this._orchestrationDb)
      this.ensureOrchestrationFederationRelay()
      this.scheduleRestoredMessageRepoints()
      this.bindWorkerTerminalAutoRelease(this._orchestrationDb)
      // Recover deadlines armed before a restart.
      getWorkerTerminalAutoReleaseScheduler(this).rearm()
      this.continueRestoredWorkerMail(this._orchestrationDb)
      // No terminal prompt's hold survives a restart; its card must not stay answerable.
      closeOrphanedTerminalApprovals(this._orchestrationDb)
      const opened = this._orchestrationDb
      scheduleWorkerOutputCopyRemoval(
        opened,
        this.orchestrationDbPath(),
        () => this._orchestrationDb === opened
      )
    }
    return this._orchestrationDb
  }

  /** The database, opened only if it already exists: a profile without one has no mail to redrive. */
  getExistingOrchestrationDb(): OrchestrationDb | null {
    return this._orchestrationDb || existsSync(this.orchestrationDbPath())
      ? this.getOrchestrationDb()
      : null
  }

  setOrchestrationDb(db: OrchestrationDb): void {
    this.orchestrationFederation.resetForDatabaseChange()
    this.mailPointerRepointScheduler.clear()
    this._orchestrationDb = db
    this.bindMailHandBack(db)
    this.bindCrewChanges(db)
    this.ensureOrchestrationFederationRelay()
    this.scheduleRestoredMessageRepoints()
    this.bindWorkerTerminalAutoRelease(db)
  }

  private bindMailHandBack(db: OrchestrationDb): void {
    db.mailHandBackListener = (handBack) => this.offerHandedBackMail(db, handBack)
  }

  /** Wakes the Run for helper mail its creator's settlement moved there, once that committed. */
  private offerHandedBackMail(db: OrchestrationDb, handBack: MailHandBack): void {
    // A replaced database's consumers belong to another runtime.
    if (this._orchestrationDb !== db) {
      return
    }
    try {
      if (db.db.isTransaction) {
        this.mailPointerRepointScheduler.schedule(handBack.mailbox)
        return
      }
      // Re-read committed rows so rolled-back settlements wake nobody.
      for (const type of committedHandBackTypes(db, handBack)) {
        this.notifyMessageArrived(handBack.mailbox, type)
      }
    } catch (error) {
      console.warn('[orchestration] failed to offer handed-back helper mail', error)
      this.mailPointerRepointScheduler.schedule(handBack.mailbox)
    }
  }
}
