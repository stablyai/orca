import type { ExecutionHostId } from '../../shared/execution-host'
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
import { cloneWorkspaceSessionState } from '../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../persistence/restoring-sessions/workspace-session-write-rollback'

export class RuntimeLegacyWorkerTerminalRecoveryPersistence {
  constructor(
    private readonly getStore: () => RuntimeStore | null,
    private readonly getDb: () => OrchestrationDb,
    private readonly getHostId: (worktreeId: string) => ExecutionHostId | null
  ) {}

  prepare(dispatchIds?: readonly string[]): LegacyWorkerTerminalRecoveryPlan {
    return this.getPlan(dispatchIds) ?? { candidates: [], ambiguousDispatchIds: [] }
  }

  async persist(
    resolutions: readonly LegacyWorkerRecoveryResolution[]
  ): Promise<ReadonlySet<string>> {
    if (resolutions.length === 0) {
      return new Set()
    }
    const store = this.getStore()
    if (!store?.getWorkspaceSession || !store.setWorkspaceSession || !store.runDurableMutation) {
      return new Set()
    }
    const getWorkspaceSession = store.getWorkspaceSession.bind(store)
    const setWorkspaceSession = store.setWorkspaceSession.bind(store)
    const originals = new Map<ExecutionHostId, WorkspaceSessionState>()
    const staged = new Map<ExecutionHostId, WorkspaceSessionState>()
    const dispatchIds = new Set<string>()
    let adopted = false
    try {
      return await store.runDurableMutation(() => {
        for (const { candidate, resolution, hostId: observedHostId } of resolutions) {
          const hostId = observedHostId ?? this.getHostId(candidate.worktreeId)
          const session = hostId ? getWorkspaceSession(hostId) : null
          if (!hostId || !session) {
            continue
          }
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
            originals.set(hostId, originals.get(hostId) ?? cloneWorkspaceSessionState(session))
            setWorkspaceSession(next, hostId)
          }
          adopted ||= resolution === 'adopted'
          dispatchIds.add(candidate.dispatchId)
        }
        // Rollback needs the final stored state, not a full-session copy after every worker.
        for (const hostId of originals.keys()) {
          staged.set(hostId, cloneWorkspaceSessionState(getWorkspaceSession(hostId)))
        }
        return {
          value: dispatchIds,
          persist: originals.size > 0 || adopted,
          rollback: () => {
            for (const [hostId, original] of originals) {
              if (store.getWorkspaceSessionHostIds?.().includes(hostId) === false) {
                continue
              }
              const stagedSession = staged.get(hostId)
              const current = getWorkspaceSession(hostId)
              if (!stagedSession || !current) {
                continue
              }
              const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(
                original,
                stagedSession,
                current
              )
              if (rolledBack !== current) {
                setWorkspaceSession(rolledBack, hostId)
              }
            }
          }
        }
      })
    } catch (error) {
      console.warn('[orchestration] failed to persist legacy worker recovery batch', {
        dispatchIds: [...dispatchIds],
        error
      })
      return new Set()
    }
  }

  reconcileMissing(candidate: LegacyWorkerRecoveryCandidate): boolean {
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

  private getPlan(dispatchIds?: readonly string[]): LegacyWorkerTerminalRecoveryPlan | null {
    try {
      return planLegacyWorkerTerminalRecovery(
        dispatchIds
          ? this.getDb().listLegacyWorkerTerminalRecoveryRows(dispatchIds)
          : this.getDb().listLegacyWorkerTerminalRecoveryRows()
      )
    } catch (error) {
      console.warn('[orchestration] failed to plan legacy worker terminal recovery', error)
      if (dispatchIds) {
        throw error
      }
      return null
    }
  }
}
