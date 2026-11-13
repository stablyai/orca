import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'
import { addWorktree } from '../../../git/worktrees/creation/worktree-add'
import { addSparseWorktree } from '../../../git/worktrees/creation/worktree-sparse-add'
import { localBranchExists } from '../../../git/worktrees/removal/worktree-removal'
import { pruneGitWorktrees } from '../../../git/worktrees/removal/worktree-prune-guard'
import {
  gitExecOptions,
  normalizeLocalBranchRef
} from '../../../git/worktrees/worktree-operation-options'
import { gitExecFileAsync } from '../../../git/command-runner/git-exec-file'
import { runWorktreeChangeInvalidators } from '../../../ipc/worktrees/listing/worktree-change-invalidators'
import { readWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { resolveWorktreeRemovalRepoOwner } from '../../../workspaces/removal/worktree-removal-repo-owner'
import { resolveWorktreeRemovalRoute } from '../../../workspaces/removal/worktree-removal-execution-host-route'
import { findPendingWorktreeRemovalConflict } from '../../../workspaces/removal/worktree-removal-table'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { runtimePathExists } from '../catalog/runtime-worktree-filesystem'
import type {
  RemoveManagedWorktreeOptions,
  RuntimeWorktreeRemovalTarget
} from '../catalog/runtime-worktree-selection'
import { materializeWorktreeContentPaths } from '../creation/runtime-local-worktree-materialization'

/** Archive only a live, linked Git checkout on a branch; anything else has nothing to restore. */
export async function resolveArchivableCheckout(
  store: RuntimeStore,
  target: RuntimeWorktreeRemovalTarget,
  requiredHostId: ExecutionHostId | undefined
): Promise<{ hostId: ExecutionHostId }> {
  const owner = resolveWorktreeRemovalRepoOwner(store, target.repoId, requiredHostId)
  if (owner.kind !== 'resolved' || isFolderRepo(owner.repo)) {
    throw new Error('Only a Git worktree in a tracked project can be archived.')
  }
  const repo = owner.repo
  // The owning host archives; a client never deletes another host's checkout.
  resolveWorktreeRemovalRoute(getRepoExecutionHostId(repo))
  if (findPendingWorktreeRemovalConflict(repo.path, { worktreePath: target.path })) {
    throw new Error('This workspace is already being deleted.')
  }
  const registered = (
    await listWorktreesStrict(repo.path, getLocalProjectWorktreeGitOptions(store, repo))
  ).find((worktree) => areWorktreePathsEqual(worktree.path, target.path))
  if (!registered || registered.isMainWorktree || !(await runtimePathExists(target.path))) {
    throw new Error('Only a linked Git worktree that is still on disk can be archived.')
  }
  if (!normalizeLocalBranchRef(registered.branch)) {
    throw new Error('Only a workspace on a branch can be archived.')
  }
  return { hostId: getRepoExecutionHostId(repo) }
}

// Written and flushed before Git deletes anything, so a crash mid-delete still finds the row archived.
export async function markWorktreeCheckoutArchived(
  store: RuntimeStore,
  worktreeId: string,
  hostId: ExecutionHostId,
  worktree: GitWorktreeInfo
): Promise<void> {
  const branch = normalizeLocalBranchRef(worktree.branch)
  if (!branch) {
    throw new Error('Only a workspace on a branch can be archived.')
  }
  const wasArchived = readWorktreeMetaForHost(store, worktreeId, hostId)?.isArchived === true
  store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId }), {
    isArchived: true,
    archivedCheckout: { branch, archivedAt: Date.now(), ...(wasArchived ? { wasArchived } : {}) }
  })
  await (store.flushPendingOrThrowAsync
    ? store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    : store.flushOrThrow?.())
}

/** Archive marks the row before Git deletes; a plain delete drops a leftover mark so its row is purged. */
export function archiveMarkStep(
  options: Pick<RemoveManagedWorktreeOptions, 'archive'>,
  store: RuntimeStore,
  worktreeId: string,
  hostId: ExecutionHostId
): (worktree: GitWorktreeInfo) => Promise<void> {
  return (
    options.archive?.markArchived ??
    (async () => {
      if (readWorktreeMetaForHost(store, worktreeId, hostId)?.archivedCheckout) {
        store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId }), {
          archivedCheckout: undefined
        })
      }
    })
  )
}

// A refusal or failure while Git still lists the checkout leaves an ordinary, visible workspace.
export async function unmarkArchiveIfCheckoutRemains(
  store: RuntimeStore,
  target: RuntimeWorktreeRemovalTarget,
  hostId: ExecutionHostId
): Promise<void> {
  const owner = resolveWorktreeRemovalRepoOwner(store, target.repoId, hostId)
  const mark = readWorktreeMetaForHost(store, target.id, hostId)?.archivedCheckout
  if (owner.kind !== 'resolved' || !mark) {
    return
  }
  const registered = await listWorktreesStrict(
    owner.repo.path,
    getLocalProjectWorktreeGitOptions(store, owner.repo)
  ).catch(() => null)
  if (registered?.some((worktree) => areWorktreePathsEqual(worktree.path, target.path))) {
    store.setWorktreeMeta(hostWorktreeTarget({ id: target.id, hostId }), {
      isArchived: mark.wasArchived === true,
      archivedCheckout: undefined
    })
  }
}

/** Recreate the checkout, or finish one a crash left registered on its branch; content paths are idempotent. */
export async function recreateArchivedCheckout(
  store: RuntimeStore,
  repo: Repo,
  worktreeId: string,
  path: string,
  branch: string
): Promise<{ includeCopyWarning?: string }> {
  const gitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  let registered = await listWorktreesStrict(repo.path, gitOptions)
  let atPath = registered.find((worktree) => areWorktreePathsEqual(worktree.path, path))
  if (atPath && (atPath.prunable || !(await runtimePathExists(path)))) {
    // A registration whose folder is gone would block `worktree add`; Git drops it on prune.
    await pruneGitWorktrees({ cwd: repo.path, ...gitOptions })
    registered = await listWorktreesStrict(repo.path, gitOptions)
    atPath = registered.find((worktree) => areWorktreePathsEqual(worktree.path, path))
  }
  if (atPath) {
    if (normalizeLocalBranchRef(atPath.branch) !== branch) {
      throw new Error(`Another checkout is already at ${path}.`)
    }
    // Archive only took clean checkouts; anything else is a restore cut short before Git checked out.
    const { stdout } = await gitExecFileAsync(
      ['status', '--porcelain'],
      gitExecOptions(path, gitOptions)
    )
    if (stdout.trim()) {
      throw new Error(
        `The checkout at ${path} is incomplete or changed. Move it away and restore again.`
      )
    }
    return materializeWorktreeContentPaths(repo, path, gitOptions, untimed)
  }
  const holder = registered.find((worktree) => normalizeLocalBranchRef(worktree.branch) === branch)
  if (holder) {
    throw new Error(`Branch "${branch}" is checked out at ${holder.path}. Free it to restore.`)
  }
  if (!(await localBranchExists(repo.path, branch, gitOptions))) {
    throw new Error(`Branch "${branch}" no longer exists, so this workspace cannot be restored.`)
  }
  const sparse = readWorktreeMetaForHost(
    store,
    worktreeId,
    getRepoExecutionHostId(repo)
  )?.sparseDirectories
  const addOptions = { ...gitOptions, checkoutExistingBranch: true }
  await (sparse?.length
    ? addSparseWorktree(repo.path, path, branch, sparse, undefined, false, addOptions)
    : addWorktree(repo.path, path, branch, undefined, false, false, addOptions))
  runWorktreeChangeInvalidators(repo.id)
  return materializeWorktreeContentPaths(repo, path, gitOptions, untimed)
}

const untimed = { time: <T>(_phase: string, operation: () => Promise<T>) => operation() }
