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
  /** PTY bound to this pane in the current session, if it has one. */
  getBoundPtyIdForPaneKey: (paneKey: string) => string | undefined
  /** PTY this pane was bound to when the session was last persisted; covers panes
   *  whose surviving daemon session has not been reattached yet. */
  getPersistedPtyIdForPaneKey: (paneKey: string) => string | undefined
}

/** A terminal that dies while Orca is down never reaches the PTY-exit teardown, so its restored
 *  row would claim work forever. Stand in for that exit: retire restored rows whose local PTY
 *  the provider proves absent, through the same path an observed exit takes. */
export async function retireRestoredStatusesWithDeadTerminals(
  deps: RestoredStatusDeadTerminalSweepDeps
): Promise<number> {
  const probesByPtyId = new Map<string, Promise<boolean | null>>()
  const isProvenAbsent = async (ptyId: string): Promise<boolean> => {
    let probe = probesByPtyId.get(ptyId)
    if (!probe) {
      // Why: a probe that throws is unverifiable, never evidence the terminal died.
      probe = deps.probePtyLiveness(ptyId).catch(() => null)
      probesByPtyId.set(ptyId, probe)
    }
    return (await probe) === false
  }
  const candidates = deps.server.listUnconfirmedRestoredStatuses().filter(
    (row) =>
      // Why: only a local pane's PTY lives in this machine's provider.
      isLocalHookConnectionId(row.connectionId) && deps.isLocalExecutionHost(row.worktreeId)
  )
  const probed = await Promise.all(
    candidates.map(async (row) => {
      const boundPtyId = deps.getBoundPtyIdForPaneKey(row.paneKey)
      const ptyId = boundPtyId ?? deps.getPersistedPtyIdForPaneKey(row.paneKey)
      return { row, boundPtyId, absent: ptyId !== undefined && (await isProvenAbsent(ptyId)) }
    })
  )
  // Why: a pane can report, or cold restore can rebind its PTY, while the probes are in flight.
  const stillRestored = new Set(deps.server.listUnconfirmedRestoredStatuses())
  const ended = probed.filter(
    ({ row, boundPtyId, absent }) =>
      absent && stillRestored.has(row) && deps.getBoundPtyIdForPaneKey(row.paneKey) === boundPtyId
  )
  // Why: the conversation outlived its terminal, so keep it resumable.
  return deps.server.reconcileEndedProcessForPaneKeys(
    ended.map(({ row }) => row.paneKey),
    { preserveResumeIdentity: true }
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
