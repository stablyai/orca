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

/**
 * The tab whose live layout holds this leaf. Only the leaf half of a pane key is remint-stable —
 * `detachTerminalPaneToTab` moves a live pane into a new tab, so a stored tabId names the tab the
 * pane left. Callers fencing on location must resolve it here rather than trust a frozen tabId.
 *
 * Stateless on purpose: writers graft leaves by assigning into a layout that is already inside the
 * layouts record, so any cache here would need a revalidation key that is itself O(tabs) per read —
 * the same cost as this walk, with a staleness invariant to keep. `Object.keys` over a guarded
 * `for...in` is deliberate too: the key array is cheaper than a `hasOwn` call per tab (measured).
 */
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

/** Partitions that own terminal panes; `runtime:` partitions mirror another host's. */
export function isTerminalOwnerPartition(hostId: ExecutionHostId): boolean {
  const kind = parseExecutionHostId(hostId)?.kind
  return kind === 'local' || kind === 'ssh'
}

/** Puts one partition's session in place and names the profile domain that now needs a write. */
export function assignWorkspaceSessionPartition(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): 'workspaceSession' | 'workspaceSessionsByHostId' {
  // Why: 'local' always lives in workspaceSession, never workspaceSessionsByHostId.local.
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    state.workspaceSession = session
    return 'workspaceSession'
  }
  state.workspaceSessionsByHostId = { ...state.workspaceSessionsByHostId, [hostId]: session }
  return 'workspaceSessionsByHostId'
}
