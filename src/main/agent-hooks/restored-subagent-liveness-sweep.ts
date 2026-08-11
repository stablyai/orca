import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { resolveDeclaredFolderScopeOwner } from '../../shared/folder-workspace-owner-resolution'
import type { FolderWorkspace, ProjectGroup } from '../../shared/types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'

export type RestoredSubagentLivenessSweepDeps = {
  /** Targeted provider liveness, or null when the provider cannot prove either state. */
  probeLiveLocalPty: (ptyId: string) => Promise<boolean | null>
  isLocalExecutionHost: (worktreeId: string | undefined) => boolean
  /** PTY bound to this pane in the current session, if it has one. */
  getBoundPtyIdForPaneKey: (paneKey: string) => string | undefined
  /** PTY this pane was bound to when the session was last persisted; covers panes
   *  whose surviving daemon session has not been reattached yet. */
  getPersistedPtyIdForPaneKey: (paneKey: string) => string | undefined
  reap: (
    isLocalExecutionHost: (worktreeId: string | undefined) => boolean,
    isLocalPaneAgentLive: (paneKey: string) => Promise<boolean>,
    isLocalPaneLivenessEvidenceCurrent: (paneKey: string) => boolean
  ) => Promise<number>
}

/** Drop restored rows only when the owning host is local and its provider proves
 *  the exact PTY absent. */
export async function sweepRestoredSubagentsWithoutLiveAgent(
  deps: RestoredSubagentLivenessSweepDeps
): Promise<number> {
  const probesByPtyId = new Map<string, Promise<boolean | null>>()
  const boundPtyIdAtProbeByPaneKey = new Map<string, string | undefined>()
  return await deps.reap(
    (worktreeId) => deps.isLocalExecutionHost(worktreeId),
    async (paneKey) => {
      const boundPtyId = deps.getBoundPtyIdForPaneKey(paneKey)
      boundPtyIdAtProbeByPaneKey.set(paneKey, boundPtyId)
      const ptyId = boundPtyId ?? deps.getPersistedPtyIdForPaneKey(paneKey)
      if (!ptyId) {
        return true
      }
      try {
        let probe = probesByPtyId.get(ptyId)
        if (!probe) {
          probe = deps.probeLiveLocalPty(ptyId)
          probesByPtyId.set(ptyId, probe)
        }
        const live = await probe
        const currentBoundPtyId = deps.getBoundPtyIdForPaneKey(paneKey)
        // Why: cold restore can rebind the persisted id while its absence probe is in flight.
        return currentBoundPtyId !== boundPtyId || live !== false
      } catch {
        return true
      }
    },
    (paneKey) =>
      !boundPtyIdAtProbeByPaneKey.has(paneKey) ||
      deps.getBoundPtyIdForPaneKey(paneKey) === boundPtyIdAtProbeByPaneKey.get(paneKey)
  )
}

/** Index the persisted terminal layouts as `paneKey -> ptyId`. Layout leaves are
 *  the only persisted binding that carries a stable pane key, so tab-level PTY ids
 *  (legacy numeric panes) are deliberately skipped. */
export function indexPersistedPaneKeyPtyIds(
  layoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> } | undefined>
): Map<string, string> {
  const byPaneKey = new Map<string, string>()
  for (const [tabId, layout] of Object.entries(layoutsByTabId)) {
    for (const [leafId, ptyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
      if (ptyId) {
        byPaneKey.set(`${tabId}:${leafId}`, ptyId)
      }
    }
  }
  return byPaneKey
}

type AgentWorkspaceExecutionHostDeps = {
  getRepo: (repoId: string) => ExecutionHostOwner | null | undefined
  getWorktreeMeta: (worktreeId: string) => { hostId?: string | null } | null | undefined
  getFolderWorkspaces: () => readonly Pick<
    FolderWorkspace,
    'id' | 'projectGroupId' | 'connectionId' | 'executionHostId'
  >[]
  getProjectGroups: () => readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
}

type ExecutionHostOwner = {
  connectionId?: string | null
  executionHostId?: string | null
}

function resolveDeclaredExecutionHost(owner: ExecutionHostOwner): ExecutionHostId | null {
  const resolved = resolveDeclaredFolderScopeOwner(owner)
  return resolved.status === 'owned'
    ? resolved.executionHostId
    : resolved.status === 'unknown'
      ? LOCAL_EXECUTION_HOST_ID
      : null
}

function resolveFolderWorkspaceExecutionHost(
  workspace: Pick<FolderWorkspace, 'projectGroupId' | 'connectionId' | 'executionHostId'>,
  projectGroups: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
): ExecutionHostId | null {
  const groups = projectGroups.filter((candidate) => candidate.id === workspace.projectGroupId)
  if (groups.length === 0) {
    return null
  }
  if (workspace.executionHostId?.trim() || workspace.connectionId !== undefined) {
    return resolveDeclaredExecutionHost(workspace)
  }
  return groups.length === 1 ? resolveDeclaredExecutionHost(groups[0]!) : null
}

/** Resolve persisted workspace ownership; unknown provenance is not local authority. */
export function resolveAgentWorkspaceExecutionHostId(
  workspaceId: string | undefined,
  deps: AgentWorkspaceExecutionHostDeps
): ExecutionHostId | null {
  if (!workspaceId) {
    return null
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const workspaces = deps
      .getFolderWorkspaces()
      .filter((workspace) => workspace.id === scope.folderWorkspaceId)
    if (workspaces.length === 0) {
      return null
    }
    const projectGroups = deps.getProjectGroups()
    const owners = new Set<ExecutionHostId>()
    let localOwnerCount = 0
    for (const workspace of workspaces) {
      const owner = resolveFolderWorkspaceExecutionHost(workspace, projectGroups)
      if (!owner) {
        return null
      }
      owners.add(owner)
      if (owner === LOCAL_EXECUTION_HOST_ID) {
        localOwnerCount += 1
      }
    }
    if (localOwnerCount === 1) {
      return LOCAL_EXECUTION_HOST_ID
    }
    return localOwnerCount === 0 && owners.size === 1 ? [...owners][0]! : null
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const declaredWorktreeHost = deps.getWorktreeMeta(worktreeId)?.hostId?.trim()
  if (declaredWorktreeHost) {
    return parseExecutionHostId(declaredWorktreeHost)?.id ?? null
  }
  const repo = deps.getRepo(getRepoIdFromWorktreeId(worktreeId))
  return repo ? resolveDeclaredExecutionHost(repo) : null
}

export function isLocalExecutionHost(hostId: string | null | undefined): boolean {
  return parseExecutionHostId(hostId)?.kind === 'local'
}
