import { crewWorkspaceNames } from '../../orchestration/crew/crew-workspace-names'
import { isDeepStrictEqual } from 'node:util'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { TerminalListHostScope } from '../../terminal/query/terminal-list-host-scope'

export abstract class OrcaRuntimeWithGetRuntimeId extends TerminalListHostScope {
  getRuntimeId(): string {
    return this.runtimeId
  }

  getStartedAt(): number {
    return this.startedAt
  }

  protected tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null {
    return this.workspaceSessions.tryGetHostId(worktreeId)
  }

  protected getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId {
    return this.workspaceSessions.getHostId(worktreeId)
  }

  // Why by tab: one worktree's tabs can be split across local and runtime partitions (#18202).
  protected getWorkspaceSessionHostIdsForTab(worktreeId: string, tabId: string): ExecutionHostId[] {
    return this.workspaceSessions.getHostIdsForTab(worktreeId, tabId)
  }

  /** The partitions a layout command reaches: its tab's holders, else the worktree's own. */
  protected layoutCommandHostIds(worktreeId: string, tabId: string | null): ExecutionHostId[] {
    return tabId !== null
      ? this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId)
      : [this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId) ?? []].flat()
  }

  protected getWorkspaceSessionHostIdsForTabs(
    worktreeId: string,
    tabIds: readonly string[]
  ): ExecutionHostId[] {
    return this.workspaceSessions.getHostIdsForTabs(worktreeId, tabIds)
  }

  protected getWorkspaceSessionHostIdForTab(worktreeId: string, tabId: string): ExecutionHostId {
    return (
      this.workspaceSessions.getHostIdsForTab(worktreeId, tabId)[0] ??
      this.workspaceSessions.getHostId(worktreeId)
    )
  }

  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null {
    return this.workspaceSessions.get(worktreeId)
  }

  protected getOwnWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null {
    return this.workspaceSessions.getOwnPartition(worktreeId)
  }

  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void {
    const before = crewWorkspaceNames(this.workspaceSessions.get(worktreeId))
    this.workspaceSessions.setForWorktree(worktreeId, session)
    if (!isDeepStrictEqual(before, crewWorkspaceNames(this.workspaceSessions.get(worktreeId)))) {
      this.crewChanges.notify(new Set(['names']))
    }
  }

  protected getKnownWorkspaceSessionWorktreeIds(): Set<string> {
    return this.workspaceSessions.getKnownWorktreeIds()
  }

  protected getWorkspaceSessionHydrationTargets(
    includeAllPersistedWorktrees: boolean
  ): Map<string, WorkspaceSessionState> {
    return this.workspaceSessions.getHydrationTargets(includeAllPersistedWorktrees)
  }
}
