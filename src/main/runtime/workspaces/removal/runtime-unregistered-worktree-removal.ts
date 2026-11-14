import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import { usesNativeWindowsRemoval } from '../../../git/worktrees/removal/windows-worktree-removal'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import {
  resolveWorktreeRemovalHome,
  type WorktreeRemovalRoute
} from '../../../workspaces/removal/worktree-removal-execution-host-route'
import {
  prepareLocalWorktreeFilesystem,
  type LocalWorktreeFilesystem
} from '../../../workspaces/removal/local-worktree-filesystem'
import { cleanupUnusedWorktreePushTargetRemote } from '../../../ipc/worktree-remote'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  isDangerousWorktreeRemovalPath,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  UNREGISTERED_MISSING_WORKTREE_MESSAGE
} from '../../../workspaces/removal/worktree-removal-safety'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { RuntimeWorktreeRemovalTarget } from '../catalog/runtime-worktree-selection'
import { isLocalRuntimeWorktreePathMissing } from '../catalog/runtime-worktree-filesystem'

type RemovalGate = { finish: (removed: boolean) => Promise<void> }

export async function removeRuntimeUnregisteredWorktree(args: {
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  registeredWorktrees: readonly GitWorktreeInfo[]
  removedMeta: WorktreeMeta | undefined
  removedPushTarget: GitPushTarget | undefined
  force: boolean
  allowUnverifiedPtyStop: boolean
  /** One resolved host for the whole removal. */
  route: WorktreeRemovalRoute
  localOptions: LocalProjectWorktreeGitOptions
  store: RuntimeStore
  acquireWatcherRemoval: (path: string) => Promise<RemovalGate>
  stopPtys: (worktreeId: string, allow: boolean) => Promise<void>
  finishRemoval: () => void | Promise<void>
}): Promise<{}> {
  const { repo, target, registeredWorktrees, removedMeta, route } = args
  const removalHome = resolveWorktreeRemovalHome(route)
  let filesystem: LocalWorktreeFilesystem | undefined
  let canCleanOrphanedDirectory = false
  if (
    canCleanupUnregisteredOrcaWorktreeDirectory({ meta: removedMeta }) &&
    !isDangerousWorktreeRemovalPath(target.path, repo.path, removalHome)
  ) {
    filesystem = await prepareLocalWorktreeFilesystem([target.path, repo.path], args.localOptions)
    canCleanOrphanedDirectory = await canSafelyRemoveOrphanedWorktreeDirectory(
      filesystem.runtimePath(target.path),
      filesystem.runtimePath(repo.path),
      removalHome,
      filesystem.access
    )
    filesystem.assertCurrent()
  }
  const native = usesNativeWindowsRemoval(target.path, args.localOptions)
  if (canCleanOrphanedDirectory || (native && removedMeta)) {
    assertWorktreeDoesNotContainRegisteredWorktree(target.path, registeredWorktrees)
    if (canCleanOrphanedDirectory && !args.force) {
      throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
    }

    const scope =
      filesystem ??
      (await prepareLocalWorktreeFilesystem([target.path, repo.path], args.localOptions))
    await deleteUnregisteredDirectory(args, scope)
    return {}
  }
  const scope =
    filesystem ??
    (await prepareLocalWorktreeFilesystem([target.path, repo.path], args.localOptions))
  if (await isLocalRuntimeWorktreePathMissing(target.path, args.localOptions, scope)) {
    if (!args.force && !removedMeta) {
      throw new Error(UNREGISTERED_MISSING_WORKTREE_MESSAGE)
    }
    const gate = await args.acquireWatcherRemoval(target.path)
    let completed = false
    try {
      scope.assertCurrent()
      try {
        await cleanupPushTarget(args)
      } finally {
        scope.assertCurrent()
        // Deleting an archived workspace forgets it; the purge keeps only rows still marked.
        if (removedMeta?.archivedCheckout) {
          args.store.setWorktreeMeta(hostWorktreeTarget({ id: target.id, hostId: route.hostId }), {
            archivedCheckout: undefined
          })
        }
        await args.finishRemoval()
        scope.assertCurrent()
        completed = true
      }
    } finally {
      await gate.finish(completed)
    }
    return {}
  }
  throw new Error(`Refusing to delete unregistered worktree path: ${target.path}`)
}

async function deleteUnregisteredDirectory(
  args: Parameters<typeof removeRuntimeUnregisteredWorktree>[0],
  filesystem: LocalWorktreeFilesystem
): Promise<void> {
  const gate = await args.acquireWatcherRemoval(args.target.path)
  let completed = false
  try {
    filesystem.assertCurrent()
    await args.stopPtys(args.target.id, args.allowUnverifiedPtyStop)
    filesystem.assertCurrent()
    await (usesNativeWindowsRemoval(args.target.path, args.localOptions)
      ? removeWorktree(args.repo.path, args.target.path, args.force, {
          ...args.localOptions,
          deleteBranch: false,
          knownRemovedWorktree: null
        })
      : filesystem.remove(args.target.path))
    filesystem.assertCurrent()
    completed = true
    try {
      await cleanupPushTarget(args)
    } finally {
      filesystem.assertCurrent()
      await args.finishRemoval()
    }
  } finally {
    await gate.finish(completed)
  }
}

async function cleanupPushTarget(
  args: Parameters<typeof removeRuntimeUnregisteredWorktree>[0]
): Promise<void> {
  await cleanupUnusedWorktreePushTargetRemote(
    args.repo.path,
    args.target.id,
    args.removedPushTarget,
    args.store,
    args.localOptions
  )
}
