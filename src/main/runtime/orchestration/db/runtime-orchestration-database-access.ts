import type { TerminalIdentityReadContext } from '../../terminal/query/terminal-identity-read-context'
import { getWorkerTerminalAutoReleaseScheduler } from '../terminal-authority/release/worker-terminal-auto-release-scheduler'
import { OrchestrationDb } from './orchestration-db'
import { OrchestrationDbMaintenance } from './maintenance/orchestration-db-maintenance'
import { closeOrchestrationReader } from './reader-worker/orchestration-reader-client'
import {
  OrchestrationDbCompaction,
  type OrchestrationDbSwap
} from './maintenance/orchestration-db-compaction'
import { structuredWorkerSession } from '../terminal-authority/structured-sessions/structured-worker-authority'
import { structuredWorkerIdentityFromRow } from '../terminal-authority/structured-sessions/structured-worker-identity'
import { isStructuredWorkerHandle } from '../../../../shared/orchestration/workers/structured-worker-handle'
import { committedHandBackTypes, type MailHandBack } from './messages/helper-mailbox-hand-back'
import { existsSync } from 'node:fs'
import { structuredMailboxCustody } from '../mailbox/routing/structured-session-mail-target'
import { closeOrphanedTerminalApprovals } from '../workers/approvals/terminal-approval-orphans'
import { OrcaRuntimeWithAutomationApiOperations } from '../../workspaces/persisted-surfaces/automation-api-operations'

export abstract class RuntimeOrchestrationDatabaseAccess extends OrcaRuntimeWithAutomationApiOperations {
  private orchestrationDbMaintenance: OrchestrationDbMaintenance | undefined
  private orchestrationDbCompaction: OrchestrationDbCompaction | undefined
  private orchestrationDbCompactionAllowed = false
  private orchestrationDbClosedForQuit = false

  abstract ensureOrchestrationFederationRelay(
    runId?: string,
    options?: { keepAwake?: boolean }
  ): void

  protected abstract scheduleRestoredMessageRepoints(): void

  abstract hasLiveTerminalForPaneKey(
    paneKey: string,
    context?: TerminalIdentityReadContext
  ): boolean

  /** Mail a worker left unread when it reported before a restart still continues it. */
  protected abstract continueRestoredWorkerMail(db: OrchestrationDb): void

  // Defer until userData is final; tests can inject an in-memory DB.
  getOrchestrationDb(): OrchestrationDb {
    if (this.orchestrationDbClosedForQuit) {
      throw new Error('The orchestration database is closed for quit.')
    }
    if (!this._orchestrationDb) {
      const filename = this.orchestrationDbPath()
      const db = new OrchestrationDb(filename)
      this._orchestrationDb = db
      this.orchestrationDbCompaction = new OrchestrationDbCompaction(
        db,
        filename,
        () => this.orchestrationDbCompactionAllowed
      )
      this.orchestrationDbMaintenance = new OrchestrationDbMaintenance(
        db,
        (dispatchId) => isReleasedChatReadable(db, dispatchId),
        {
          isLiveHandle: (handle) => this.isLiveOrchestrationHandle(handle),
          isLivePane: (paneKey) => this.hasLiveTerminalForPaneKey(paneKey),
          waitedMailboxes: () => this.messageWaiters.map.keys()
        },
        this.orchestrationDbCompaction
      )
      this.orchestrationDbMaintenance.start()
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
    }
    return this._orchestrationDb
  }

  /** The database, opened only if it already exists: a profile without one has no mail to redrive. */
  getExistingOrchestrationDb(): OrchestrationDb | null {
    if (this.orchestrationDbClosedForQuit) {
      return null
    }
    return this._orchestrationDb || existsSync(this.orchestrationDbPath())
      ? this.getOrchestrationDb()
      : null
  }

  /** Desktop only: the copy is swapped in at quit, and only the desktop quit does that. */
  allowOrchestrationDbCompaction(): void {
    this.orchestrationDbCompactionAllowed = true
  }

  /** At the end of a clean quit: swaps in a compacted copy taken while the file sat unwritten. */
  async swapCompactedOrchestrationDbForQuit(): Promise<OrchestrationDbSwap> {
    const compaction = this.orchestrationDbCompaction
    if (!compaction?.hasCopy) {
      // A partial copy is as large as the live data; a later launch may never clean it up.
      await compaction?.discardUnfinishedCopy()
      return { kind: 'none' }
    }
    // Its idle connection would hold the file open and make every swap busy.
    await closeOrchestrationReader()
    return compaction.swapAtQuit(() => this.detachOrchestrationDbForQuit())
  }

  /** At the end of a clean quit: hands the open database to the swap, which closes it; never reopened. */
  private detachOrchestrationDbForQuit(): Promise<void> {
    this.orchestrationDbClosedForQuit = true
    const stopped = this.orchestrationDbMaintenance?.stop() ?? Promise.resolve()
    this.orchestrationDbMaintenance = undefined
    this._orchestrationDb = null
    return stopped
  }

  setOrchestrationDb(db: OrchestrationDb): void {
    void this.orchestrationDbMaintenance?.stop()
    this.orchestrationDbMaintenance = undefined
    this.orchestrationDbCompaction = undefined
    this.orchestrationFederation.resetForDatabaseChange()
    this.mailPointerRepointScheduler.clear()
    this._orchestrationDb = db
    this.bindMailHandBack(db)
    this.bindCrewChanges(db)
    this.ensureOrchestrationFederationRelay()
    this.scheduleRestoredMessageRepoints()
    this.bindWorkerTerminalAutoRelease(db)
  }

  /** Whether anyone can still read this mailbox: a waiter, an open terminal or a reachable chat. */
  private isLiveOrchestrationHandle(handle: string): boolean {
    return (
      this.messageWaiters.has(handle) ||
      this.orchestrationMailboxDeliveryTarget.reachesOpenTerminal(handle) ||
      structuredMailboxCustody(handle, this._orchestrationDb) !== 'elsewhere'
    )
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

/** Whether a released chat worker's reference read would find its chat on this host. */
function isReleasedChatReadable(db: OrchestrationDb, dispatchId: string): boolean {
  const handle =
    db.getWorkerDispatch(dispatchId)?.agent_terminal_handle ??
    db.getDispatchContextById(dispatchId)?.assignee_handle
  const row =
    handle && isStructuredWorkerHandle(handle) ? db.getWorkerTerminalResourceByHandle(handle) : null
  // From the row, not the identity registry: released workers must stay unregistered.
  const identity = row ? structuredWorkerIdentityFromRow(row) : null
  return identity !== null && structuredWorkerSession(identity).kind === 'here'
}
