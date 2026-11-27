import { orchestrationDbFile } from '../../orchestration/db/orchestration-db-file'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { OrcaRuntimeWithPtyForegroundProcessReads } from '../../client/runtime-client-state'
import { getWorkerTerminalAutoReleaseScheduler } from '../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { AgentActivityOrchestrationResult } from '../../../../shared/rpc-contract/agent-activity/agent-activity-params'
import { createAgentOrchestrationChangeNotice } from './agent-orchestration-change-notice'
import { AgentOrchestrationSnapshotRevision } from './agent-orchestration-snapshot-revision'

// Keyed by runtime, not a field: the database can open while the runtime is still constructing.
const runtimesWatchingAutoReleaseSetting = new WeakSet<object>()

export abstract class OrcaRuntimeWithOrchestrationDatabaseBinding extends OrcaRuntimeWithPtyForegroundProcessReads {
  protected orchestrationDbPath(): string {
    return orchestrationDbFile(getAppEnvironment().getPath('userData'))
  }

  /** A paired computer handed back replies to asks: the asking chats' cards read them again. */
  notifyPeerMailReturned(): void {
    this.notifier?.peerMailReturned?.()
    this.emitClientEvent({ type: 'peerMailReturned' })
  }

  private readonly agentOrchestrationSnapshot = new AgentOrchestrationSnapshotRevision(() =>
    this.agentOrchestrationByPaneKey()
  )

  // Paired desktops re-read this host's worker lineage on it, whether a chat or a terminal created the Dispatch.
  private readonly noteAgentOrchestrationChanged = createAgentOrchestrationChangeNotice(() =>
    this.emitClientEvent({ type: 'agentOrchestrationChanged' })
  )

  readAgentOrchestrationSince(sinceRevision?: number): AgentActivityOrchestrationResult {
    return this.agentOrchestrationSnapshot.since(sinceRevision)
  }

  protected bindWorkerTerminalAutoRelease(db: OrchestrationDb): void {
    // A worker can settle with no agent phase change (a failed start, a release); bots re-read.
    db.workerStatusListener = (dispatchId, change) => {
      this.botDispatchChanged(dispatchId, change)
      this.agentOrchestrationSnapshot.invalidate()
      this.noteAgentOrchestrationChanged()
    }
    db.workerTerminalAutoReleaseListener = () => {
      if (this._orchestrationDb === db) {
        getWorkerTerminalAutoReleaseScheduler(this).rearm()
      }
    }
    db.sessionWorkersListener = (sessionId) => {
      this.notifier?.orchestrationSessionWorkersChanged?.(sessionId)
      this.emitClientEvent({ type: 'orchestrationSessionWorkersChanged', sessionId })
    }
    // A paired server's changed verdict writes no row, so its readers are told here.
    db.federatedWorkersListener = (dispatchIds) => {
      this.botFederatedWorkersChanged(dispatchIds)
      const sessions = new Set(
        dispatchIds.flatMap((id) => db.getDispatchContextById(id)?.creator_orca_session_id ?? [])
      )
      for (const sessionId of sessions) {
        db.sessionWorkersListener?.(sessionId)
      }
    }
    db.workerAutoReleaseEnabled = () =>
      this.store?.getSettings?.()?.orchestrationWorkerAutoReleaseEnabled !== false
    if (this.store?.onSettingsChanged && !runtimesWatchingAutoReleaseSetting.has(this)) {
      runtimesWatchingAutoReleaseSetting.add(this)
      // Turning the setting off drops the timer; turning it on finds the deadlines still due.
      this.store.onSettingsChanged((updates) => {
        if ('orchestrationWorkerAutoReleaseEnabled' in updates && this._orchestrationDb) {
          getWorkerTerminalAutoReleaseScheduler(this).rearm()
        }
      })
    }
  }
}
