import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from '../../terminal/surface/mobile-session-terminal-persistence-retirement'
import type { OrchestrationDb } from '../db/orchestration-db'
import {
  reportWorkerTurnStop,
  type WorkerTurnStopReportDeps
} from '../workers/turn-stops/worker-turn-stop-report'
import {
  planLegacyWorkerTerminalRecovery,
  type LegacyWorkerTerminalRecoveryPlan
} from './release/orchestration-legacy-worker-terminal-recovery'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryResolution
} from './structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { cloneWorkspaceSessionState } from '../../../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../../../persistence/restoring-sessions/workspace-session-write-rollback'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'

/** Where a running worker a recovery pass finds gone is reported, with its terminal's last lines. */
export type LostWorkerReport = {
  reportDeps: WorkerTurnStopReportDeps
  lastOutput: (ptyId: string) => Promise<string | undefined>
}

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
          if (record && worktreeIdsEqual(record.worktreeId, candidate.worktreeId)) {
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

  reconcileMissing(
    candidate: LegacyWorkerRecoveryCandidate,
    lostWorkers: LostWorkerReport | null = null
  ): boolean {
    try {
      const db = this.getDb()
      const before = db.getDispatchContextById(candidate.dispatchId)
      const worker = db.reconcileMissingWorkerTerminal(
        candidate.dispatchId,
        'The assigned worker terminal is no longer live after orchestration recovery.'
      )
      const settled = db.getDispatchContextById(candidate.dispatchId)?.status
      // Only a running worker this pass failed; a pending stop ends as asked, and settled rows were told before.
      if (
        lostWorkers &&
        before &&
        ['pending', 'dispatched'].includes(before.status) &&
        worker.state === 'abandoned' &&
        (settled === 'failed' || settled === 'circuit_broken')
      ) {
        // Its last output is read from saved history, so the report follows the settlement.
        void lostWorkers
          .lastOutput(candidate.ptyId)
          .catch(() => undefined)
          .then((lastOutput) =>
            reportWorkerTurnStop(
              db,
              { kind: 'local', dispatch: before },
              {
                from: candidate.terminalHandle,
                reason: 'lost',
                cause: 'its terminal was gone when Orca restarted',
                lastOutput,
                settled
              },
              lostWorkers.reportDeps
            )
          )
      }
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
