import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import type { OrchestrationDb } from './orchestration/db'
import {
  planLegacyWorkerTerminalRecovery,
  type LegacyWorkerTerminalRecoveryPlan
} from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type { RuntimeStore } from './runtime-store-contract'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryResolution
} from './runtime-legacy-worker-terminal-recovery-types'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-failed-write-rollback'

export class RuntimeLegacyWorkerTerminalRecoveryPersistence {
  constructor(
    private readonly getStore: () => RuntimeStore | null,
    private readonly getDb: () => OrchestrationDb,
    private readonly getHostId: (worktreeId: string) => ExecutionHostId | null
  ) {}

  prepare(): LegacyWorkerTerminalRecoveryPlan {
    const plan = this.getPlan()
    const store = this.getStore()
    if (
      !store?.getWorkspaceSession ||
      !store.setWorkspaceSession ||
      (!store.flushPendingOrThrowAsync && !store.flushOrThrow)
    ) {
      return plan
    }
    const sessions = new Map<
      ExecutionHostId,
      { current: WorkspaceSessionState; next: WorkspaceSessionState }
    >()
    const changedHostIds = new Set<ExecutionHostId>()
    for (const blocked of plan.blockedPanes) {
      let hostIds: ExecutionHostId[]
      try {
        const hostId = this.getHostId(blocked.worktreeId)
        if (!hostId) {
          throw new Error('folder_workspace_not_found')
        }
        hostIds = [hostId]
      } catch (error) {
        console.warn('[orchestration] legacy worker resume fence owner is unavailable', {
          worktreeId: blocked.worktreeId,
          error
        })
        hostIds = store.getWorkspaceSessionHostIds?.() ?? [LOCAL_EXECUTION_HOST_ID]
      }
      for (const hostId of hostIds) {
        let state = sessions.get(hostId)
        if (!state) {
          const current = store.getWorkspaceSession(hostId)
          if (!current) {
            continue
          }
          state = { current, next: structuredClone(current) }
          sessions.set(hostId, state)
        }
        const record = state.next.sleepingAgentSessionsByPaneKey?.[blocked.paneKey]
        if (
          !record ||
          !runtimeWorktreeIdsEqual(record.worktreeId, blocked.worktreeId) ||
          record.automaticResumeBlockedBy === 'legacy-orchestration-worker'
        ) {
          continue
        }
        state.next.sleepingAgentSessionsByPaneKey = {
          ...state.next.sleepingAgentSessionsByPaneKey,
          [blocked.paneKey]: { ...record, automaticResumeBlockedBy: 'legacy-orchestration-worker' }
        }
        changedHostIds.add(hostId)
      }
    }
    const changed = [...sessions].filter(([hostId]) => changedHostIds.has(hostId))
    if (changed.length === 0) {
      return plan
    }
    try {
      for (const [hostId, state] of changed) {
        store.setWorkspaceSession(state.next, hostId)
      }
    } catch (error) {
      console.warn('[orchestration] failed to stage legacy worker resume fence', error)
    }
    return plan
  }

  async persist(
    resolutions: readonly LegacyWorkerRecoveryResolution[]
  ): Promise<ReadonlySet<string>> {
    const store = this.getStore()
    if (
      !store?.getWorkspaceSession ||
      !store.setWorkspaceSession ||
      (!store.flushPendingOrThrowAsync && !store.flushOrThrow)
    ) {
      return new Set()
    }
    const originals = new Map<ExecutionHostId, WorkspaceSessionState>()
    const staged = new Map<ExecutionHostId, WorkspaceSessionState>()
    const dispatchIds = new Set<string>()
    try {
      for (const { candidate, resolution } of resolutions) {
        const hostId = this.getHostId(candidate.worktreeId)
        const session = hostId ? store.getWorkspaceSession(hostId) : null
        if (!hostId || !session) {
          continue
        }
        originals.set(hostId, originals.get(hostId) ?? session)
        let next =
          resolution === 'exited'
            ? retireTerminalSurfaceFromPersistence(session, {
                worktreeId: candidate.worktreeId,
                parentTabId: candidate.tabId,
                leafId: candidate.leafId,
                ptyId: candidate.ptyId,
                incarnationId: candidate.incarnationId
              })
            : session
        const record = next.sleepingAgentSessionsByPaneKey?.[candidate.paneKey]
        if (record && runtimeWorktreeIdsEqual(record.worktreeId, candidate.worktreeId)) {
          const sleeping = { ...next.sleepingAgentSessionsByPaneKey }
          delete sleeping[candidate.paneKey]
          next = { ...next, sleepingAgentSessionsByPaneKey: sleeping }
        }
        if (next !== session) {
          store.setWorkspaceSession(next, hostId)
        }
        staged.set(hostId, store.getWorkspaceSession(hostId))
        dispatchIds.add(candidate.dispatchId)
      }
      if (dispatchIds.size > 0) {
        await this.flush(store)
      }
      return dispatchIds
    } catch (error) {
      for (const [hostId, original] of originals) {
        const stagedSession = staged.get(hostId)
        const current = store.getWorkspaceSession(hostId)
        if (!stagedSession || !current) {
          continue
        }
        const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(
          original,
          stagedSession,
          current
        )
        if (rolledBack !== current) {
          store.setWorkspaceSession(rolledBack, hostId)
        }
      }
      console.warn('[orchestration] failed to persist legacy worker recovery batch', {
        dispatchIds: [...dispatchIds],
        error
      })
      return new Set()
    }
  }

  reconcileMissing(candidate: LegacyWorkerRecoveryCandidate): boolean {
    if (candidate.dispatchStatus !== 'pending' && candidate.dispatchStatus !== 'dispatched') {
      return true
    }
    try {
      this.getDb().reconcileMissingWorkerTerminal(
        candidate.dispatchId,
        'The assigned worker terminal is no longer live after orchestration recovery.'
      )
      return true
    } catch (error) {
      console.warn('[orchestration] failed to reconcile missing worker terminal', {
        dispatchId: candidate.dispatchId,
        error
      })
      return false
    }
  }

  private getPlan(): LegacyWorkerTerminalRecoveryPlan {
    try {
      return planLegacyWorkerTerminalRecovery(this.getDb().listLegacyWorkerTerminalRecoveryRows())
    } catch (error) {
      console.warn('[orchestration] failed to plan legacy worker terminal recovery', error)
      return { blockedPanes: [], candidates: [], ambiguousDispatchIds: [] }
    }
  }

  private async flush(store: RuntimeStore): Promise<void> {
    if (store.flushPendingOrThrowAsync) {
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return
    }
    if (store.flushOrThrow) {
      store.flushOrThrow()
      return
    }
    throw new Error('workspace_session_persistence_unavailable')
  }
}
