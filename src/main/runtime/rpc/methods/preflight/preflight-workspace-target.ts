import type { OrcaRuntimeService } from '../../../orca-runtime'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { resolveQualifiedFolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import {
  resolveConfiguredWindowsAgentDetectionHost,
  resolveWorkspaceAgentDetectionHost
} from '../../../../preflight/workspace-agent-detection'
import { resolveWorktreeHostRouting } from '../../../workspaces/catalog/worktree-launch-host-repo'

export async function resolveQualifiedAgentDetectionHost(
  runtime: Pick<
    OrcaRuntimeService,
    'requireStore' | 'resolveAgentDetectionHost' | 'showManagedWorktree'
  >,
  params: {
    worktreeId?: string
    worktreeHostId?: ExecutionHostId
    repoId?: string
    configuredWindowsRuntime?: true
  },
  selectedWorktree?: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>,
  selectedFolder?: NonNullable<ReturnType<OrcaRuntimeService['resolveManagedFolderWorkspace']>>
) {
  if (params.configuredWindowsRuntime) {
    return resolveConfiguredWindowsAgentDetectionHost(runtime.requireStore())
  }
  const hostId = params.worktreeHostId
  if (!hostId || !params.worktreeId) {
    return runtime.resolveAgentDetectionHost(params.worktreeId, params.repoId)
  }
  const store = runtime.requireStore()
  const scope = parseWorkspaceKey(params.worktreeId)
  if (scope?.type === 'folder') {
    const groups = selectedFolder?.catalog.projectGroups ?? store.getProjectGroups?.() ?? []
    const repos = selectedFolder?.catalog.repos ?? store.getRepos()
    const selected =
      selectedFolder ??
      resolveQualifiedFolderWorkspace(
        {
          folderWorkspaces: store.getFolderWorkspaces?.() ?? [],
          projectGroups: groups,
          repos
        },
        scope.folderWorkspaceId,
        hostId,
        () => new Error('worktree_execution_host_unresolved')
      )
    if (selected.workspace.id !== scope.folderWorkspaceId || selected.hostId !== hostId) {
      throw new Error('worktree_execution_host_unresolved')
    }
    return resolveWorkspaceAgentDetectionHost(
      {
        getSettings: () => store.getSettings(),
        getProjects: () => store.getProjects?.() ?? [],
        getRepos: () => repos,
        getProjectGroups: () => groups,
        getFolderWorkspaces: () => [selected.workspace]
      },
      { kind: 'folder', folderWorkspaceId: scope.folderWorkspaceId, selected }
    )
  }
  const worktree =
    selectedWorktree ?? (await runtime.showManagedWorktree(`id:${params.worktreeId}`, hostId))
  const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
  if (routing.kind !== 'resolved' || !routing.repo || routing.hostId !== hostId) {
    throw new Error('worktree_execution_host_unresolved')
  }
  return resolveWorkspaceAgentDetectionHost(store, { kind: 'worktree', ...worktree }, routing)
}
