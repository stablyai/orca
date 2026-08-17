import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
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
  getFolderWorkspace: (
    folderWorkspaceId: string
  ) => Pick<FolderWorkspace, 'projectGroupId' | 'connectionId'> | null | undefined
  getProjectGroups: () => readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
}

type ExecutionHostOwner = {
  connectionId?: string | null
  executionHostId?: string | null
}

function resolveDeclaredExecutionHost(owner: ExecutionHostOwner): ExecutionHostId | null {
  if (owner.executionHostId?.trim()) {
    return parseExecutionHostId(owner.executionHostId)?.id ?? null
  }
  const connectionId = owner.connectionId?.trim()
  return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
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
    const workspace = deps.getFolderWorkspace(scope.folderWorkspaceId)
    const group = workspace
      ? deps.getProjectGroups().find((candidate) => candidate.id === workspace.projectGroupId)
      : undefined
    if (!workspace || !group) {
      return null
    }
    return resolveDeclaredExecutionHost({
      connectionId: workspace.connectionId ?? group.connectionId,
      executionHostId: group.executionHostId
    })
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
