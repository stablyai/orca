import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { gitExecFileAsync } from '../git/runner'
import { isENOENT } from '../ipc/filesystem-auth'
import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath
} from '../local-worktree-filesystem'
import {
  ExecutionHostNotDispatchableError,
  resolveFilesystemRouteForHost
} from '../providers/execution-host-provider-dispatch'
import { isWorktreePathMissing } from '../worktree-removal-safety'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  getRuntimeFolderWorkspaceRootId,
  isRuntimeFolderWorkspaceIdForRepo,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'
import type { RuntimeStore } from './runtime-store-contract'
import { gitStatusErrorMeansNotRepository } from './runtime-worktree-selection'

// Takes the resolved host rather than the repo: reading `repo.connectionId` answered "stat this on
// the client" for a row that names its owner only as `executionHostId: 'ssh:<target>'`, which is
// the evidence a forced removal prunes registrations on.
export async function isRuntimeWorktreePathMissing(
  hostId: ExecutionHostId,
  worktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  const route = resolveFilesystemRouteForHost(hostId)
  if (route.kind === 'runtime') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  if (route.kind === 'local') {
    const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
    return isWorktreePathMissing(
      toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
      access.statPath
    )
  }
  const fsProvider = route.provider
  return fsProvider ? isWorktreePathMissing(worktreePath, (path) => fsProvider.stat(path)) : false
}

export async function isLocalRuntimeGitRepository(
  runtimeWorktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  try {
    await gitExecFileAsync(['status', '--short'], {
      cwd: runtimeWorktreePath,
      ...localWorktreeGitOptions
    })
    return true
  } catch (error) {
    return !gitStatusErrorMeansNotRepository(error)
  }
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
      : existing || repoOwnerCount === 1
        ? store.setWorktreeMeta(worktreeId, {
            instanceId: getRuntimeFolderWorkspaceInstanceIdentity(repo, worktreeId),
            ...(existing ? {} : { displayName: repo.displayName, lastActivityAt: Date.now() })
          })
        : {}
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
