import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Repo } from '../../../shared/repository/repo-types'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { getRepoMainWorktreeId } from '../../../shared/worktree/id'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { normalizeGitRepoRootForInputPath } from '../../git/repositories/discovery/repo-detection'
import { invalidateAuthorizedRootsCache } from '../../ipc/worktrees/removal/registered-worktree-roots-cache'
import { hostWorktreeTargetForRepo } from '../../persistence/host-qualified-worktree-meta'
import { assertWslMoveRepoWritable } from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { findProjectAtSameRealPath } from '../../workspaces/catalog/project-realpath-identity'
import { prepareLocalWorktreeRootForRepo } from '../../workspaces/creation/worktree-root-preparation'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { runtimePathsEqual } from '../workspaces/catalog/runtime-worktree-path-identity'
import { runtimeRepoIsRegistrationCandidate } from '../workspaces/catalog/runtime-worktree-selection'

type RepoRelocationDependencies = {
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
  notifyWorktreeFolderRenamed: (
    repoId: string,
    oldWorktreeId: string,
    newWorktreeId: string
  ) => void
}

type Checkout = { rootPath: string; gitDir: string; commonDir: string }

/** Null when `path` is missing or not inside a Git work tree. */
async function readCheckout(path: string): Promise<Checkout | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
      { cwd: path }
    )
    // Git < 2.31 echoes the unsupported flag and prints relative dirs.
    const [rootPath, gitDir, commonDir] = stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0 && !line.startsWith('-'))
    if (!rootPath || !gitDir || !commonDir) {
      return null
    }
    return {
      rootPath: normalizeGitRepoRootForInputPath(path, rootPath),
      gitDir: await realpath(resolve(path, gitDir)),
      commonDir: await realpath(resolve(path, commonDir))
    }
  } catch {
    return null
  }
}

/** Point a local Git project at another path of the same checkout, keeping its id and the primary workspace's sessions. */
export async function relocateRepoPath(
  store: RuntimeStore,
  repo: Repo,
  requestedPath: string,
  deps: RepoRelocationDependencies
): Promise<Repo> {
  // Local Git projects only for now; SSH/WSL/folder projects need host-side path rules first.
  if (
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
    parseWslUncPath(repo.path) ||
    parseWslUncPath(requestedPath)
  ) {
    throw new Error('Changing the path is only supported for local projects.')
  }
  if (isFolderRepo(repo)) {
    throw new Error('Changing the path is only supported for Git projects.')
  }
  if (!isAbsolute(requestedPath)) {
    throw new Error('Project path must be an absolute path')
  }
  const checkout = await readCheckout(requestedPath)
  if (!checkout) {
    throw new Error(`Not a valid git repository: ${requestedPath}`)
  }
  if (checkout.gitDir !== checkout.commonDir) {
    throw new Error(
      `${requestedPath} is a linked worktree of ${dirname(checkout.commonDir)}. Use the main checkout's path.`
    )
  }
  // Store Git's resolved toplevel, as adding a project does.
  const newPath = checkout.rootPath
  if (runtimePathsEqual(newPath, repo.path)) {
    return repo
  }
  const others = store
    .getRepos()
    .filter((other) => other.id !== repo.id && runtimeRepoIsRegistrationCandidate(other))
  const duplicate =
    others.find((other) => runtimePathsEqual(other.path, newPath)) ??
    (await findProjectAtSameRealPath(others, newPath))
  if (duplicate) {
    throw new Error(`${newPath} is already registered as project "${duplicate.displayName}".`)
  }
  // A missing or non-Git old path means the folder moved; an existing one must be this repository.
  const oldCheckout = await readCheckout(repo.path)
  if (oldCheckout && oldCheckout.commonDir !== checkout.commonDir) {
    throw new Error(
      `${newPath} is a different repository from ${repo.path}. Add it as a new project instead.`
    )
  }
  if (!store.migrateWorktreeIdentity) {
    throw new Error('runtime_unavailable')
  }
  assertWslMoveRepoWritable(store, repo)
  const oldWorktreeId = getRepoMainWorktreeId(repo)
  const newWorktreeId = getRepoMainWorktreeId({ id: repo.id, path: newPath })
  // Rekey before the path write so pruning never sees the primary workspace's sessions as orphans.
  store.migrateWorktreeIdentity(hostWorktreeTargetForRepo(oldWorktreeId, repo), newWorktreeId)
  const updated = store.updateRepo(repo, {
    path: newPath,
    // The new path is Git's own toplevel, so the folder-upgrade locator no longer applies.
    ...(repo.folderUpgradeGitRootPath ? { folderUpgradeGitRootPath: undefined } : {})
  })
  if (!updated) {
    throw new Error('repo_not_found')
  }
  deps.notifyWorktreeFolderRenamed(repo.id, oldWorktreeId, newWorktreeId)
  await prepareLocalWorktreeRootForRepo(store, updated)
  invalidateAuthorizedRootsCache()
  deps.invalidateResolvedWorktrees()
  deps.invalidateWorktreeScan(repo.id)
  deps.notifyReposChanged()
  return updated
}
