import { getWorkerTerminalAutoReleaseScheduler } from '../../orchestration/worker-terminal-auto-release-scheduler'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { OrcaRuntimeWithAutomationApiOperations } from './automation-api-operations'
import { OrchestrationDb } from '../../orchestration/db'
import {
  committedHandBackTypes,
  type MailHandBack
} from '../../orchestration/db/messages/helper-mailbox-hand-back'
import { existsSync } from 'node:fs'
import type { LegacyWorkerTerminalRecoveryPlan } from '../../orchestration/orchestration-legacy-worker-terminal-recovery'
import type { LegacyWorkerTerminalRecoveryResult } from '../../runtime-legacy-worker-terminal-recovery-types'

export abstract class OrcaRuntimeWithAutomationOperations extends OrcaRuntimeWithAutomationApiOperations {
  abstract ensureOrchestrationFederationRelay(runId?: string): void
  protected abstract scheduleRestoredMessageRepoints(): void
  /** Mail a worker left unread when it reported before a restart still continues it. */
  protected abstract continueRestoredWorkerMail(db: OrchestrationDb): void
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
  protected abstract getLeafKey(tabId: string, leafId: string): string

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

  protected async flushWorkspaceSessionOrThrowAsync(): Promise<void> {
    const store = this.store
    if (store?.flushPendingOrThrowAsync) {
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return
    }
    if (store?.flushOrThrow) {
      store.flushOrThrow()
      return
    }
    throw new Error('workspace_session_persistence_unavailable')
  }

  async reconcileLegacyWorkerTerminals(
    options: { connectionId?: string; materializeRenderer?: boolean } = {}
  ): Promise<LegacyWorkerTerminalRecoveryResult> {
    return this.legacyWorkerRecovery.reconcile(options)
  }

  stopLegacyWorkerTerminalRecovery(): Promise<void> {
    return this.legacyWorkerRecovery.stop()
  }

  protected updateLegacyWorkerTerminalRecoveryRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: { connectionId?: string; materializeRenderer?: boolean }
  ): void {
    this.legacyWorkerRecovery.updateRetry(plan, deferredDispatchIds, options)
  }

  async refreshRestoredOrchestrationAuthority(connectionId: string | null = null): Promise<void> {
    if (connectionId === null && !this.canRecoverPersistentLocalPtysFn()) {
      return
    }
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      [...(await this.getResolvedWorktreeMap()).values()],
      null,
      undefined,
      connectionId
    )
    if (!inventory) {
      throw new Error('terminal_liveness_unavailable')
    }
  }
}
