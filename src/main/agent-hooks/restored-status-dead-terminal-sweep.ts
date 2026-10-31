import {
  getConnectionExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { isLocalHookConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { AgentHookServer } from './server'

type RestoredStatusSweepServer = Pick<
  AgentHookServer,
  'listUnconfirmedRestoredStatuses' | 'reconcileEndedProcessForPaneKeys'
>

export type RestoredStatusDeadTerminalSweepDeps = {
  server: RestoredStatusSweepServer
  /** Targeted provider liveness: true live, false absent, null when it cannot prove either. */
  probePtyLiveness: (ptyId: string) => Promise<boolean | null>
  isLocalExecutionHost: (worktreeId: string | undefined) => boolean
  getBoundPtyIdForPaneKey: (paneKey: string) => string | undefined
  /** Covers surviving daemon PTYs not yet reattached to the current session. */
  getPersistedPtyIdForPaneKey: (paneKey: string) => string | undefined
}

/** Retire restored local rows only when the provider proves their PTY absent. */
export async function retireRestoredStatusesWithDeadTerminals(
  deps: RestoredStatusDeadTerminalSweepDeps
): Promise<number> {
  const probesByPtyId = new Map<string, Promise<boolean | null>>()
  const isProvenAbsent = async (ptyId: string): Promise<boolean> => {
    let probe = probesByPtyId.get(ptyId)
    if (!probe) {
      // A failed probe cannot prove the terminal died.
      probe = deps.probePtyLiveness(ptyId).catch(() => null)
      probesByPtyId.set(ptyId, probe)
    }
    return (await probe) === false
  }
  const candidates = deps.server.listUnconfirmedRestoredStatuses().filter(
    (row) =>
      // Only local PTYs belong to this provider.
      isLocalHookConnectionId(row.connectionId) && deps.isLocalExecutionHost(row.worktreeId)
  )
  const probed = await Promise.all(
    candidates.map(async (row) => {
      const boundPtyId = deps.getBoundPtyIdForPaneKey(row.paneKey)
      const ptyId = boundPtyId ?? deps.getPersistedPtyIdForPaneKey(row.paneKey)
      return { row, boundPtyId, absent: ptyId !== undefined && (await isProvenAbsent(ptyId)) }
    })
  )
  // Rows and PTY bindings can change while probes are in flight.
  const stillRestored = new Set(deps.server.listUnconfirmedRestoredStatuses())
  const ended = probed.filter(
    ({ row, boundPtyId, absent }) =>
      absent && stillRestored.has(row) && deps.getBoundPtyIdForPaneKey(row.paneKey) === boundPtyId
  )
  // Preserve conversations that outlived their terminals for resume.
  return deps.server.reconcileEndedProcessForPaneKeys(
    ended.map(({ row }) => row.paneKey),
    { preserveResumeIdentity: true }
  )
}

/** Only layout leaves persist stable pane keys; skip legacy tab-level PTY bindings. */
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
  return getConnectionExecutionHostId(owner.connectionId?.trim())
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
