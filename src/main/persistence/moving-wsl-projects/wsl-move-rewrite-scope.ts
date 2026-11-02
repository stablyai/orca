/**
 * What a committed WSL move's desktop rewrite stores ask of a row: is it one of the moved
 * projects, and what are its id and path on the host. Ids keep their repo; only a UNC path of the
 * moved distro changes, through the same rewrite the manifest was built with.
 */
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  normalizeWorkspaceSessionKeyToWorkspaceId,
  parseWorkspaceKey
} from '../../../shared/workspace-scope'
import { rewriteOrcadMigrationWorktreeId } from '../../ssh/orcad-migration-path-rewrite'
import type { WslMoveDesktopRewriteContext } from './wsl-move-desktop-rewrite-stores'

export type WslMoveRewriteScope = {
  /** A worktree id, workspace key or host-qualified identity of a moved project. */
  inScope: (owner: string) => boolean
  repoInScope: (repoId: string) => boolean
  /** The host's id for a moved worktree id; anything else is returned unchanged. */
  worktreeId: (worktreeId: string) => string
  /** The host's path for an absolute UNC path of the moved distro; anything else unchanged. */
  path: (value: string) => string
  destinationHostId: WslMoveDesktopRewriteContext['destinationHostId']
}

export function wslMoveRewriteScope(context: WslMoveDesktopRewriteContext): WslMoveRewriteScope {
  const { source } = context.cutover.manifest
  const repoIds = new Set(source.scopeRepoIds)
  const folderWorkspaceIds = new Set(source.scopeFolderWorkspaceIds)
  return {
    inScope: (owner) => {
      const parsed = parseWorkspaceKey(owner)
      if (parsed?.type === 'folder') {
        return folderWorkspaceIds.has(parsed.folderWorkspaceId)
      }
      const id = normalizeWorkspaceSessionKeyToWorkspaceId(owner)
      return folderWorkspaceIds.has(id) || repoIds.has(getRepoIdFromWorktreeId(id))
    },
    repoInScope: (repoId) => repoIds.has(repoId),
    worktreeId: (worktreeId) => rewriteOrcadMigrationWorktreeId(worktreeId, context.rewritePath),
    path: (value) => context.rewritePath.path(value, 'absolute'),
    destinationHostId: context.destinationHostId
  }
}
