import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalOrphanAdoptionResult
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../persistence/restoring-sessions/workspace-session-write-rollback'
import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import {
  planRuntimeTerminalOrphanAdoption,
  type RuntimeTerminalOrphanAdoptionPlan,
  type RuntimeTerminalOrphanAdoptionPlanArgs,
  type RuntimeTerminalOrphanAdoptionPlanPorts,
  type RuntimeTerminalOrphanAdoptionSession
} from './runtime-terminal-orphan-adoption-plan'

type AdoptPlan = Extract<RuntimeTerminalOrphanAdoptionPlan, { kind: 'adopt' }>

type RuntimeTerminalOrphanAdoptionPorts = RuntimeTerminalOrphanAdoptionPlanPorts & {
  /** Replays a binding the session already held: names the pane without claiming the graph holds it. */
  replayPersistedSurface: (pty: RuntimePtyWorktreeRecord, tabId: string, paneKey: string) => void
  /** Names a pane this adoption just wrote, ahead of the graph statement that will carry it. */
  recordAdoptedSurface: (pty: RuntimePtyWorktreeRecord, tabId: string, paneKey: string) => void
  /** The session as it is now; throws the refusal when it cannot be read. */
  readSession: () => RuntimeTerminalOrphanAdoptionSession
  getSession: (worktreeId: string) => WorkspaceSessionState | null
  setSession: (worktreeId: string, session: WorkspaceSessionState) => void
  /** The store's durable transaction; without one, `flushSession` writes and the rollback is manual. */
  runDurableMutation?: <T>(mutate: () => DurableProfileStateMutation<T>) => Promise<T>
  flushSession: () => Promise<void>
  hydrateSession: (worktreeId: string) => void
  notifySessionChanged: (worktreeId: string) => void
  getSnapshot: (worktreeId: string) => RuntimeMobileSessionTabsResult
}

export async function adoptRuntimeTerminalOrphansFromInventory(
  args: RuntimeTerminalOrphanAdoptionPlanArgs & {
    repoId: string
    ports: RuntimeTerminalOrphanAdoptionPorts
  }
): Promise<RuntimeTerminalOrphanAdoptionResult> {
  const { workspace, ports } = args
  const plan = (): RuntimeTerminalOrphanAdoptionPlan =>
    planRuntimeTerminalOrphanAdoption(args, ports.readSession())
  const stage = (planned: AdoptPlan): (() => void) => {
    ports.setSession(workspace.id, planned.persisted)
    const staged = ports.getSession(workspace.id)
    return () => {
      const current = ports.getSession(workspace.id)
      if (!staged || !current) {
        return
      }
      const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(
        planned.session,
        staged,
        current
      )
      if (rolledBack !== current) {
        ports.setSession(workspace.id, rolledBack)
      }
    }
  }
  let planned: RuntimeTerminalOrphanAdoptionPlan
  if (ports.runDurableMutation) {
    // Why checked and written inside the store's transaction: a write queued ahead may change the
    // session, and only the transaction's rollback skips the topology-fence rebase, which treats
    // a write below the fence (this rollback) as a stale renderer replay and keeps the adoption.
    const outcome = await ports.runDurableMutation<RuntimeTerminalOrphanAdoptionPlan | Error>(
      () => {
        let next: RuntimeTerminalOrphanAdoptionPlan
        try {
          next = plan()
        } catch (error) {
          // A throwing callback freezes the store; a refusal must not.
          return {
            value: error instanceof Error ? error : new Error(String(error)),
            persist: false
          }
        }
        return next.kind === 'replay'
          ? { value: next, persist: false }
          : { value: next, rollback: stage(next) }
      }
    )
    if (outcome instanceof Error) {
      throw outcome
    }
    planned = outcome
  } else {
    planned = plan()
    if (planned.kind === 'adopt') {
      const rollback = stage(planned)
      try {
        await ports.flushSession()
      } catch (error) {
        rollback()
        throw error
      }
    }
  }
  if (planned.kind === 'replay') {
    for (const { claim, pty, paneKey } of planned.validated) {
      ports.replayPersistedSurface(pty, claim.tabId, paneKey)
    }
    return {
      adopted: false,
      topologyRevision: planned.currentRevision,
      snapshot: ports.getSnapshot(workspace.id)
    }
  }
  for (const { claim, pty, paneKey } of planned.validated) {
    ports.recordAdoptedSurface(pty, claim.tabId, paneKey)
  }
  ports.hydrateSession(workspace.id)
  ports.notifySessionChanged(workspace.id)
  return {
    adopted: true,
    topologyRevision:
      planned.persisted.terminalTopologyRevisionByRepoId?.[args.repoId] ??
      planned.currentRevision + 1,
    snapshot: ports.getSnapshot(workspace.id)
  }
}
