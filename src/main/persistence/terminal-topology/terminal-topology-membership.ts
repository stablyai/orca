import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'

export function advanceTerminalTopologyRevision(
  session: WorkspaceSessionState,
  worktreeId: string
): WorkspaceSessionState {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return {
    ...session,
    terminalTopologyRevisionByRepoId: {
      ...session.terminalTopologyRevisionByRepoId,
      [repoId]: (session.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) + 1
    }
  }
}

/** Resolve current ownership after detaches; leaf IDs survive moves while tab IDs do not. */
export function findTerminalTabIdForLeaf(
  session: WorkspaceSessionState | undefined,
  leafId: string
): string | undefined {
  const layouts = session?.terminalLayoutsByTabId
  if (!layouts) {
    return undefined
  }
  for (const tabId of Object.keys(layouts)) {
    if (layoutContainsLeafId(layouts[tabId]?.root ?? null, leafId)) {
      return tabId
    }
  }
  return undefined
}

export function hasHostAuthoritativeTerminalMembership(
  session: WorkspaceSessionState | undefined,
  worktreeId: string
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return (
    (session?.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) > 0 ||
    Object.values(session?.terminalSurfaceTombstonesByPaneKey ?? {}).some(
      (tombstone) => tombstone.worktreeId === worktreeId
    )
  )
}

export type TerminalSessionPartition = {
  hostId: ExecutionHostId
  session: WorkspaceSessionState
}

/** Runtime partitions mirror another host; local and SSH own their panes. */
export function isTerminalOwnerPartition(hostId: ExecutionHostId): boolean {
  const kind = parseExecutionHostId(hostId)?.kind
  return kind === 'local' || kind === 'ssh'
}

export function assignWorkspaceSessionPartition(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): 'workspaceSession' | 'workspaceSessionsByHostId' {
  // Local belongs only in workspaceSession, never the host-partition map.
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    state.workspaceSession = session
    return 'workspaceSession'
  }
  state.workspaceSessionsByHostId = { ...state.workspaceSessionsByHostId, [hostId]: session }
  return 'workspaceSessionsByHostId'
}
