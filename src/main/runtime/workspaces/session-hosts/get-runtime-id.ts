import { crewWorkspaceNames } from '../../orchestration/crew/crew-workspace-names'
import { isDeepStrictEqual } from 'node:util'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { TerminalListHostScope } from '../../terminal/query/terminal-list-host-scope'
import type { RuntimeWorkspaceSelectors } from '../workspace-selectors'

export abstract class OrcaRuntimeWithGetRuntimeId extends TerminalListHostScope {
  protected abstract buildResolvedWorktreeForHost(
    ...args: Parameters<RuntimeWorkspaceSelectors['buildResolvedWorktreeForHost']>
  ): ReturnType<RuntimeWorkspaceSelectors['buildResolvedWorktreeForHost']>

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

  /** This host's own saved sleeping-agent records, folder workspaces included: terminal agent
   *  ids name conversations on this host only, so no other partition or workspace is visited. */
  readLocalSleepingAgentSessions(): Readonly<Record<string, SleepingAgentSessionRecord>> {
    return (
      this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.sleepingAgentSessionsByPaneKey ??
      {}
    )
  }

  /** One place's labels as `agent list` shows them, from that host's records by key: its row in
   *  the published catalog, else its own repo and metadata. Never another host's same-id
   *  workspace, and never a scan of every workspace or repo. */
  getWorkspaceLabel(
    worktreeId: string,
    hostId: ExecutionHostId
  ): { workspace: string; repo?: string } | null {
    const folder = parseWorkspaceKey(worktreeId)
    if (folder?.type === 'folder') {
      const name = this.store?.getFolderWorkspace?.(folder.folderWorkspaceId)?.name
      return name ? { workspace: name } : null
    }
    const worktree =
      this.resolvedWorktrees.lookup(hostId, worktreeId) ??
      this.buildResolvedWorktreeForHost(worktreeId, hostId)
    if (!worktree?.displayName) {
      return null
    }
    const repo = this.store?.getRepoForHost?.(worktree.repoId, hostId)
    return { workspace: worktree.displayName, repo: repo?.displayName ?? worktree.repoId }
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
