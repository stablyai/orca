import { crewWorkspaceNames } from '../../orchestration/crew/crew-workspace-names'
import { isDeepStrictEqual } from 'node:util'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { TerminalListHostScope } from '../../terminal/query/terminal-list-host-scope'
import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'

const worktreesById = new WeakMap<readonly ResolvedWorktree[], Map<string, ResolvedWorktree>>()

function resolvedWorktreeById(
  worktrees: readonly ResolvedWorktree[] | undefined,
  worktreeId: string
): ResolvedWorktree | undefined {
  if (!worktrees) {
    return undefined
  }
  let byId = worktreesById.get(worktrees)
  if (!byId) {
    byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
    worktreesById.set(worktrees, byId)
  }
  return byId.get(worktreeId)
}

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

  /** One workspace's labels as `agent list` shows them, by key: its row in the cached resolved
   *  worktree list (indexed once per list), else its saved record; never a scan of every
   *  workspace. */
  getWorkspaceLabel(worktreeId: string): { workspace: string; repo?: string } | null {
    const folder = parseWorkspaceKey(worktreeId)
    if (folder?.type === 'folder') {
      const name = this.store?.getFolderWorkspace?.(folder.folderWorkspaceId)?.name
      return name ? { workspace: name } : null
    }
    const worktree =
      resolvedWorktreeById(this.resolvedWorktrees.peek()?.worktrees, worktreeId) ??
      this.buildResolvedWorktreeFromId(worktreeId)
    if (!worktree?.displayName) {
      return null
    }
    const repo = this.store?.getRepo(worktree.repoId)
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
