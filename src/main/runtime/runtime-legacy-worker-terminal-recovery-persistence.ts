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
    private readonly getHostId: (worktreeId: string) => ExecutionHostId | null,
    /** The store write only reaches the next app start; a live renderer holds its own copy. */
    private readonly notifyFenceChanged?: (paneKey: string, blocked: boolean) => void
  ) {}

  /** Panes announced as fenced before any sleeping record existed; the only place a lift for one
   *  can come from, because `liftRetiredFences` can only see panes that already have a record. */
  private readonly announcedBlockedPaneKeys = new Set<string>()

  prepare(): LegacyWorkerTerminalRecoveryPlan {
    const plan = this.getPlan()
    if (!plan) {
      // An unreadable plan is not evidence that any pane stopped needing its fence: stamp
      // nothing, lift nothing, retry on the next pass.
      return { blockedPanes: [], candidates: [], ambiguousDispatchIds: [] }
    }
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
    const fenceChanges: [string, boolean][] = []
    for (const blocked of plan.blockedPanes) {
      // A worker can settle while its tab is still open, so there is no sleeping record to stamp
      // yet. Tell the live renderer anyway: it mints the record on close and must fence it there.
      if (!this.announcedBlockedPaneKeys.has(blocked.paneKey)) {
        this.announcedBlockedPaneKeys.add(blocked.paneKey)
        fenceChanges.push([blocked.paneKey, true])
      }
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
    this.liftRetiredFences(store, plan, sessions, changedHostIds, fenceChanges)
    const changed = [...sessions].filter(([hostId]) => changedHostIds.has(hostId))
    try {
      for (const [hostId, state] of changed) {
        store.setWorkspaceSession(state.next, hostId)
      }
    } catch (error) {
      console.warn('[orchestration] failed to stage legacy worker resume fence', error)
      return plan
    }
    for (const [paneKey, blocked] of fenceChanges) {
      this.notifyFenceChanged?.(paneKey, blocked)
    }
    return plan
  }

  /** A fence that outlives its dispatch leaves a pane that can never spawn again, so release,
   *  retain, user takeover and dispatch pruning — each of which drops the row from the plan —
   *  retire it here. An unreadable plan yields no blocked panes, so callers must not sweep. */
  private liftRetiredFences(
    store: RuntimeStore,
    plan: LegacyWorkerTerminalRecoveryPlan,
    sessions: Map<ExecutionHostId, { current: WorkspaceSessionState; next: WorkspaceSessionState }>,
    changedHostIds: Set<ExecutionHostId>,
    fenceChanges: [string, boolean][]
  ): void {
    const blockedPaneKeys = new Set(plan.blockedPanes.map((blocked) => blocked.paneKey))
    for (const paneKey of this.announcedBlockedPaneKeys) {
      if (!blockedPaneKeys.has(paneKey)) {
        this.announcedBlockedPaneKeys.delete(paneKey)
        fenceChanges.push([paneKey, false])
      }
    }
    for (const hostId of store.getWorkspaceSessionHostIds?.() ?? [LOCAL_EXECUTION_HOST_ID]) {
      const staged = sessions.get(hostId)
      const session = staged?.next ?? store.getWorkspaceSession?.(hostId)
      const retired = Object.entries(session?.sleepingAgentSessionsByPaneKey ?? {}).filter(
        ([paneKey, record]) =>
          record.automaticResumeBlockedBy === 'legacy-orchestration-worker' &&
          !blockedPaneKeys.has(paneKey)
      )
      if (retired.length === 0) {
        continue
      }
      let state = staged
      if (!state) {
        const current = store.getWorkspaceSession?.(hostId)
        if (!current) {
          continue
        }
        state = { current, next: structuredClone(current) }
        sessions.set(hostId, state)
      }
      const next = { ...state.next.sleepingAgentSessionsByPaneKey }
      for (const [paneKey, record] of retired) {
        const { automaticResumeBlockedBy: _retired, ...unfenced } = record
        next[paneKey] = unfenced
        fenceChanges.push([paneKey, false])
      }
      state.next.sleepingAgentSessionsByPaneKey = next
      changedHostIds.add(hostId)
    }
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

  private getPlan(): LegacyWorkerTerminalRecoveryPlan | null {
    try {
      return planLegacyWorkerTerminalRecovery(this.getDb().listLegacyWorkerTerminalRecoveryRows())
    } catch (error) {
      console.warn('[orchestration] failed to plan legacy worker terminal recovery', error)
      return null
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
