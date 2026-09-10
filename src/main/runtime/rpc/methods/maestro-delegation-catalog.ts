import {
  getWorktreeExecutionHostId,
  normalizeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import {
  buildMaestroDelegationCatalog,
  findMaestroPlacement,
  type MaestroDelegationRuntimeSettings
} from '../../../../shared/maestro-delegation-catalog'
import type {
  MaestroDelegationCatalog,
  MaestroDelegationPlacement
} from '../../../../shared/maestro-delegation'
import type { MaestroWorkspaceAnchor } from '../../../../shared/maestro-contract'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import type { RpcContext } from '../core'

type CatalogRuntime = RpcContext['runtime']
export type MaestroDelegationCatalogSnapshot = {
  catalog: MaestroDelegationCatalog
  currentWorkspace: { execution_host_id: string; workspace_key: string } | null
}

function folderHostId(folder: ReturnType<CatalogRuntime['listFolderWorkspaces']>[number]): string {
  return (
    normalizeExecutionHostId(folder.executionHostId) ??
    (folder.connectionId ? toSshExecutionHostId(folder.connectionId) : 'local')
  )
}

function placementEntry(
  placement: MaestroDelegationPlacement,
  label: string,
  enabled = true,
  disabledReason: string | null = null
): MaestroDelegationCatalog['placements'][number] {
  return { placement, label, enabled, disabled_reason: disabledReason }
}

function currentIdentity(
  workspace: MaestroWorkspaceAnchor,
  folders: ReturnType<CatalogRuntime['listFolderWorkspaces']>,
  worktrees: Awaited<ReturnType<CatalogRuntime['listManagedWorktrees']>>['worktrees'],
  repos: ReturnType<CatalogRuntime['listRepos']>
): { execution_host_id: string; workspace_key: string } | null {
  const parsed = parseWorkspaceKey(workspace.workspace_key)
  if (parsed?.type === 'folder') {
    const folder = folders.find((candidate) => candidate.id === parsed.folderWorkspaceId)
    return folder && folderHostId(folder) === workspace.execution_host_id
      ? {
          execution_host_id: workspace.execution_host_id,
          workspace_key: folderWorkspaceKey(folder.id)
        }
      : null
  }
  if (parsed?.type !== 'worktree') {
    return null
  }
  const worktree = worktrees.find((candidate) => candidate.id === parsed.worktreeId)
  if (!worktree) {
    return null
  }
  const repo = repos.find((candidate) => candidate.id === worktree.repoId)
  const executionHostId = getWorktreeExecutionHostId(worktree, repo)
  return executionHostId === workspace.execution_host_id
    ? { execution_host_id: executionHostId, workspace_key: worktreeWorkspaceKey(worktree.id) }
    : null
}

function placements(
  folders: ReturnType<CatalogRuntime['listFolderWorkspaces']>,
  worktrees: Awaited<ReturnType<CatalogRuntime['listManagedWorktrees']>>['worktrees'],
  repos: ReturnType<CatalogRuntime['listRepos']>,
  current: { execution_host_id: string; workspace_key: string } | null
): MaestroDelegationCatalog['placements'] {
  const result: MaestroDelegationCatalog['placements'] = [
    placementEntry(
      { kind: 'current-workspace' },
      'Current workspace',
      current !== null,
      current ? null : 'The exact current execution host and workspace identity is unavailable.'
    )
  ]
  for (const folder of folders) {
    const key = folderWorkspaceKey(folder.id)
    result.push(
      placementEntry(
        { kind: 'existing-workspace', execution_host_id: folderHostId(folder), workspace_key: key },
        folder.name || key
      )
    )
  }
  for (const worktree of worktrees) {
    const repo = repos.find((candidate) => candidate.id === worktree.repoId)
    const key = worktreeWorkspaceKey(worktree.id)
    result.push(
      placementEntry(
        {
          kind: 'existing-workspace',
          execution_host_id: getWorktreeExecutionHostId(worktree, repo),
          workspace_key: key
        },
        worktree.displayName || key
      )
    )
  }
  if (current) {
    result.push(
      placementEntry(
        {
          kind: 'create-child-worktree',
          execution_host_id: current.execution_host_id,
          parent_workspace_key: current.workspace_key,
          name_hint: 'delegated-work'
        },
        'Child worktree under current workspace'
      )
    )
  }
  return result
}

export async function getMaestroDelegationCatalogSnapshot(
  runtime: CatalogRuntime,
  workspace: MaestroWorkspaceAnchor
): Promise<MaestroDelegationCatalogSnapshot> {
  const folders = runtime.listFolderWorkspaces()
  const worktrees = (await runtime.listManagedWorktrees()).worktrees
  const repos = runtime.listRepos()
  const current = currentIdentity(workspace, folders, worktrees, repos)
  const runtimeSettings: MaestroDelegationRuntimeSettings = runtime.getClientSettings()
  const catalog = buildMaestroDelegationCatalog({
    agents: ALL_TUI_AGENTS,
    settings: runtimeSettings,
    placements: placements(folders, worktrees, repos, current)
  })
  return {
    catalog: {
      ...catalog,
      agents: catalog.agents.map((agent) => ({
        ...agent,
        label: TUI_AGENT_DISPLAY_NAMES[agent.id] ?? agent.label
      }))
    },
    currentWorkspace: current
  }
}

export function resolveCatalogPlacement(
  catalog: MaestroDelegationCatalog,
  requested: MaestroDelegationPlacement
): MaestroDelegationPlacement | undefined {
  return findMaestroPlacement(catalog.placements, requested)
}
