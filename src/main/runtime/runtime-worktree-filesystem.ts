import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath
} from '../local-worktree-filesystem'
import { isWorktreePathMissing } from '../worktree-removal-safety'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  getRuntimeFolderWorkspaceRootId,
  isRuntimeFolderWorkspaceIdForRepo,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'
import type { RuntimeStore } from './runtime-store-contract'
import { isWslMoveRepoBlocked } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'
import { hostWorktreeTargetForRepo } from '../persistence/host-qualified-worktree-meta'

/** Callers hold a local removal route; an `ssh:` or `runtime:` host is refused before this. */
export async function isLocalRuntimeWorktreePathMissing(
  worktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
  return isWorktreePathMissing(
    toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
    access.statPath
  )
}

function getRuntimeFolderWorkspaceInstanceIdentity(repo: Repo, worktreeId: string): string {
  const prefix = `${getRuntimeFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  return worktreeId.startsWith(prefix) ? worktreeId.slice(prefix.length) : randomUUID()
}

export function listRuntimeFolderWorkspaces(
  store: Pick<RuntimeStore, 'getAllWorktreeMeta' | 'getRepos' | 'setWorktreeMeta'>,
  repo: Repo,
  repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Worktree[] {
  const rootId = getRuntimeFolderWorkspaceRootId(repo)
  const allMeta = store.getAllWorktreeMeta()
  const expectedHostId = getRepoExecutionHostId(repo)
  // A project a WSL move is taking still lists, without stamping identities it lacks.
  const canWrite = !isWslMoveRepoBlocked(repo)
  const ids = Object.keys(allMeta).filter(
    (worktreeId) =>
      isRuntimeFolderWorkspaceIdForRepo(repo, worktreeId) &&
      (repoOwnerCount === 1 || allMeta[worktreeId]?.hostId === expectedHostId)
  )
  if (!ids.includes(rootId)) {
    ids.unshift(rootId)
  } else {
    ids.sort((left, right) => (left === rootId ? -1 : right === rootId ? 1 : 0))
  }
  return ids.map((worktreeId) => {
    const existing = getRepoOwnedWorktreeMeta(repo, worktreeId, allMeta, repoOwnerCount)
    const meta: Partial<WorktreeMeta> = existing?.instanceId
      ? existing
      : canWrite && (existing || repoOwnerCount === 1)
        ? store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), {
            instanceId: getRuntimeFolderWorkspaceInstanceIdentity(repo, worktreeId),
            ...(existing ? {} : { displayName: repo.displayName, lastActivityAt: Date.now() })
          })
        : (existing ?? {})
    return {
      ...mergeRuntimeFolderWorkspace(repo, worktreeId, meta),
      hostId: repoOwnerCount === 1 ? (meta.hostId ?? expectedHostId) : expectedHostId
    }
  })
}

export async function runtimePathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch (error) {
    if (isENOENT(error)) {
      return false
    }
    throw error
  }
}
