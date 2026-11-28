import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { TerminalAgentWorkspaceLabels } from './terminal-agent-phone-push'

/** A terminal agent alert's workspace and project names, from memory only; `fallback` names a
 *  workspace with no record. */
export function readTerminalAgentWorkspaceLabels(
  store: RuntimeStore | null,
  listedWorktrees: readonly ResolvedWorktree[] | undefined,
  worktreeId: string,
  fallback: string
): TerminalAgentWorkspaceLabels {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const folder = store?.getFolderWorkspaces?.().find((f) => f.id === scope.folderWorkspaceId)
    const group = folder
      ? store?.getProjectGroups?.().find((item) => item.id === folder.projectGroupId)
      : undefined
    return { repoLabel: group?.name, worktreeLabel: folder?.name || fallback }
  }
  const id = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
  // Catalog changes empty the listing cache; persisted metadata remains available.
  const listed = listedWorktrees?.find((item) => item.id === id)
  const meta = listed ? undefined : store?.getWorktreeMeta(id)
  const repoId = listed?.repoId ?? (meta ? getRepoIdFromWorktreeId(id) : undefined)
  const repo = repoId ? store?.getRepo(repoId) : undefined
  return {
    repoLabel: repo?.displayName,
    worktreeLabel: listed?.displayName || listed?.branch || meta?.displayName || fallback
  }
}
