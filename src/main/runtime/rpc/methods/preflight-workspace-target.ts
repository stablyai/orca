import type { OrcaRuntimeService } from '../../orca-runtime'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { resolveQualifiedFolderWorkspace } from '../../../../shared/folder-workspace-execution-host'
import { resolveWorkspaceAgentDetectionHost } from '../../../preflight/workspace-agent-detection'
import { resolveWorktreeHostRouting } from '../../worktree-launch-host-repo'

export async function resolveQualifiedAgentDetectionHost(
  runtime: OrcaRuntimeService,
  params: { worktreeId?: string; worktreeHostId?: ExecutionHostId; repoId?: string }
) {
  const hostId = params.worktreeHostId
  if (!hostId || !params.worktreeId) {
    return runtime.resolveAgentDetectionHost(params.worktreeId, params.repoId)
  }
  const store = runtime.requireStore()
  const scope = parseWorkspaceKey(params.worktreeId)
  if (scope?.type === 'folder') {
    const groups = store.getProjectGroups?.() ?? []
    const repos = store.getRepos()
    const selected = resolveQualifiedFolderWorkspace(
      {
        folderWorkspaces: store.getFolderWorkspaces?.() ?? [],
        projectGroups: groups,
        repos
      },
      scope.folderWorkspaceId,
      hostId,
      () => new Error('worktree_execution_host_unresolved')
    )
    return resolveWorkspaceAgentDetectionHost(
      {
        getSettings: () => store.getSettings(),
        getProjects: () => store.getProjects?.() ?? [],
        getRepos: () => repos,
        getProjectGroups: () => groups,
        getFolderWorkspaces: () => [{ ...selected.workspace, executionHostId: selected.hostId }]
      },
      { kind: 'folder', folderWorkspaceId: scope.folderWorkspaceId }
    )
  }
  const worktree = await runtime.showManagedWorktree(`id:${params.worktreeId}`, hostId)
  const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
  if (routing.kind !== 'resolved' || !routing.repo || routing.hostId !== hostId) {
    throw new Error('worktree_execution_host_unresolved')
  }
  return resolveWorkspaceAgentDetectionHost(store, { kind: 'worktree', ...worktree })
}
