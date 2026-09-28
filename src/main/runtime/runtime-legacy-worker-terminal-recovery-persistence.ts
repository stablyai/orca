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

  prepare(): LegacyWorkerTerminalRecoveryPlan {
    return this.getPlan() ?? { candidates: [], ambiguousDispatchIds: [] }
  }

  async persist(
    resolutions: readonly LegacyWorkerRecoveryResolution[]
  ): Promise<ReadonlySet<string>> {
    const store = this.getStore()
    if (!store?.getWorkspaceSession || !store.setWorkspaceSession || !store.runDurableMutation) {
      return new Set()
    }
    const getWorkspaceSession = store.getWorkspaceSession.bind(store)
    const setWorkspaceSession = store.setWorkspaceSession.bind(store)
    const originals = new Map<ExecutionHostId, WorkspaceSessionState>()
    const staged = new Map<ExecutionHostId, WorkspaceSessionState>()
    const dispatchIds = new Set<string>()
    try {
      return await store.runDurableMutation(() => {
        for (const { candidate, resolution } of resolutions) {
          const hostId = this.getHostId(candidate.worktreeId)
          const session = hostId ? getWorkspaceSession(hostId) : null
          if (!hostId || !session) {
            continue
          }
          originals.set(hostId, originals.get(hostId) ?? cloneWorkspaceSessionState(session))
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
            setWorkspaceSession(next, hostId)
          }
          staged.set(hostId, cloneWorkspaceSessionState(getWorkspaceSession(hostId)))
          dispatchIds.add(candidate.dispatchId)
        }
        return {
          value: dispatchIds,
          persist: dispatchIds.size > 0,
          rollback: () => {
            for (const [hostId, original] of originals) {
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
}
