import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import { pruneGitWorktrees } from '../../git/worktrees/removal/worktree-prune-guard'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import {
  assertWorktreeUnlockedForRemoval,
  CheckoutIdentityRefusal,
  differentCheckoutAtPathError
} from '../../../shared/worktree/removal/removal'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import {
  formatWorktreeRemovalError,
  isOrphanedWorktreeError
} from '../../ipc/worktrees/paths/worktree-logic'
import { listWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'
import {
  normalizeLocalBranchRef,
  type GitWorktreeExecOptions
} from '../../git/worktrees/worktree-operation-options'
import { deleteBranchOfUnregisteredWorktree } from '../../git/worktrees/removal/worktree-removal'
import {
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePaths,
  type CheckoutMarkerState,
  type CheckoutRootState,
  type RemoveLocalWorktreeMarkerOptions
} from './local-worktree-filesystem'
import { readCheckoutMarkerState, readCheckoutRootState } from './worktree-removal-gitdir-identity'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  isDangerousWorktreeRemovalPath
} from './worktree-removal-safety'
import { provesLocalOrphanedWorktree } from './local-orphaned-worktree-proof'
import { throwIfSignalAborted } from '../../../shared/concurrency/abort-signal-reason'

type LocalPartialRemovalRecoveryArgs = {
  error: unknown
  force: boolean
  canonicalWorktreePath: string
  repoPath: string
  localWorktreeGitOptions: GitWorktreeExecOptions
  registeredWorktree: Pick<GitWorktreeInfo, 'branch' | 'head' | 'locked' | 'lockReason'>
  deleteBranch: boolean
  closeWatcher: (worktreePath: string) => Promise<void>
  signal?: AbortSignal
  /** Rechecks the folder is still the accepted checkout immediately before its files are deleted. */
  beforeLeftoverDelete?: () => Promise<void>
  expectedMarker?: string
  forbidAnyMarker?: boolean
}

type StaleLocalWorktreeRegistrationArgs = Omit<
  LocalPartialRemovalRecoveryArgs,
  | 'error'
  | 'force'
  | 'closeWatcher'
  | 'signal'
  | 'beforeLeftoverDelete'
  | 'expectedMarker'
  | 'forbidAnyMarker'
>

function preservedBranchResult(
  registeredWorktree: Pick<GitWorktreeInfo, 'branch' | 'head'>,
  deleteBranch: boolean
): RemoveWorktreeResult {
  if (!deleteBranch || !registeredWorktree.branch || !registeredWorktree.head) {
    return {}
  }
  return {
    preservedBranch: {
      branchName: registeredWorktree.branch.replace(/^refs\/heads\//, ''),
      head: registeredWorktree.head
    }
  }
}

function staleRegistrationRecoveryError(error: unknown, canonicalWorktreePath: string): Error {
  return new Error(
    `${formatWorktreeRemovalError(
      error,
      canonicalWorktreePath,
      true
    )} Git still has stale worktree registration. Retry deletion after resolving the Git registration error.`
  )
}

async function verifyGitWorktreeRegistrationRemoved(
  repoPath: string,
  localWorktreeGitOptions: GitWorktreeExecOptions,
  canonicalWorktreePath: string
): Promise<void> {
  try {
    const remainingWorktrees = await listWorktreesStrict(repoPath, localWorktreeGitOptions)
    if (
      remainingWorktrees.some((worktree) =>
        areWorktreePathsEqual(worktree.path, canonicalWorktreePath)
      )
    ) {
      throw new Error('Git still reports the worktree registration after cleanup.')
    }
  } catch (error) {
    throw staleRegistrationRecoveryError(error, canonicalWorktreePath)
  }
}

export async function removeStaleLocalWorktreeRegistration(
  args: StaleLocalWorktreeRegistrationArgs
): Promise<RemoveWorktreeResult> {
  assertWorktreeUnlockedForRemoval(args.registeredWorktree)

  let result: RemoveWorktreeResult | undefined
  let removalError: unknown
  try {
    await pruneGitWorktrees({ cwd: args.repoPath, ...args.localWorktreeGitOptions })
    result = preservedBranchResult(args.registeredWorktree, args.deleteBranch)
  } catch (error) {
    removalError = error
  }

  // Successful prune can retain locked registrations; verify the row is gone.
  try {
    await verifyGitWorktreeRegistrationRemoved(
      args.repoPath,
      args.localWorktreeGitOptions,
      args.canonicalWorktreePath
    )
  } catch (verificationError) {
    throw removalError
      ? staleRegistrationRecoveryError(removalError, args.canonicalWorktreePath)
      : verificationError
  }
  // Preserve the branch when Git may have detached the row before reporting a filesystem error.
  return result ?? preservedBranchResult(args.registeredWorktree, args.deleteBranch)
}

export async function recoverPartialLocalWorktreeRemoval(
  args: LocalPartialRemovalRecoveryArgs
): Promise<RemoveWorktreeResult | undefined> {
  throwIfSignalAborted(args.signal)
  // Reject Git locks before recovery can recursively delete files.
  assertWorktreeUnlockedForRemoval(args.registeredWorktree)

  const recoverable = await isRecoverablePartialRemovalFailure(args)
  throwIfSignalAborted(args.signal)
  if (!recoverable) {
    return undefined
  }

  // Watcher teardown awaits; pin the leftover first so a folder swapped in meanwhile is refused.
  const leftover = {
    root: await readCheckoutRootState(args.canonicalWorktreePath, args.localWorktreeGitOptions),
    marker: await readCheckoutMarkerState(args.canonicalWorktreePath, args.localWorktreeGitOptions)
  }
  throwIfSignalAborted(args.signal)
  // Release watcher handles before recursively finishing Git’s partial removal; abort if closing fails.
  await args.closeWatcher(args.canonicalWorktreePath)
  throwIfSignalAborted(args.signal)
  await args.beforeLeftoverDelete?.()
  const verifiedMarkerOptions = await assertRemainingMarkerBelongsToRepoWorktree(args, leftover)
  if (verifiedMarkerOptions) {
    try {
      await removeLocalWorktreePath(
        args.canonicalWorktreePath,
        args.localWorktreeGitOptions,
        args.signal,
        {
          markerLast: true,
          expectedMarker: args.expectedMarker ?? verifiedMarkerOptions.expectedMarker,
          forbidAnyMarker: args.forbidAnyMarker || verifiedMarkerOptions.forbidAnyMarker,
          expectedRoot: verifiedMarkerOptions.expectedRoot,
          requireMarker: verifiedMarkerOptions.requireMarker
        }
      )
    } catch (error) {
      throwIfSignalAborted(args.signal)
      if (error instanceof CheckoutIdentityRefusal) {
        throw error
      }
      throw new Error(formatWorktreeRemovalError(error, args.canonicalWorktreePath, args.force))
    }
  }
  const { branch, head } = args.registeredWorktree
  // Same -d policy as a normal delete: merged branches go, unmerged ones are preserved.
  return deleteBranchOfUnregisteredWorktree(
    args.repoPath,
    args.canonicalWorktreePath,
    args.deleteBranch && branch ? { name: normalizeLocalBranchRef(branch), head } : null,
    args.localWorktreeGitOptions
  )
}

async function assertRemainingMarkerBelongsToRepoWorktree(
  args: LocalPartialRemovalRecoveryArgs,
  leftover: { root: CheckoutRootState; marker: CheckoutMarkerState }
): Promise<Omit<RemoveLocalWorktreeMarkerOptions, 'markerLast'> | null> {
  const { canonicalWorktreePath: path, repoPath, localWorktreeGitOptions: opts, signal } = args
  const expectedMarker =
    args.expectedMarker ?? (leftover.marker.kind === 'file' ? leftover.marker.identity : undefined)
  const forbidAnyMarker = args.forbidAnyMarker || leftover.marker.kind === 'absent'
  const [runtimePath, runtimeRepoPath] = await toLocalWorktreeRuntimePaths(
    [path, repoPath],
    opts,
    signal
  )
  throwIfSignalAborted(signal)
  if (isDangerousWorktreeRemovalPath(runtimePath, runtimeRepoPath, CLIENT_REMOVAL_HOME)) {
    throw new Error(`Refusing to delete protected worktree path: ${path}`)
  }
  const rootBefore = await readCheckoutRootState(path, opts)
  throwIfSignalAborted(signal)
  if (rootBefore.kind === 'absent') {
    return null
  }
  if (
    rootBefore.kind !== 'directory' ||
    leftover.root.kind !== 'directory' ||
    (leftover.root.identity &&
      rootBefore.identity &&
      rootBefore.identity !== leftover.root.identity)
  ) {
    throw differentCheckoutAtPathError(path)
  }
  const before = await readCheckoutMarkerState(path, opts)
  throwIfSignalAborted(signal)
  if (before.kind === 'absent') {
    return {
      forbidAnyMarker: true,
      // The folder cannot be told from one recreated in place: once a .git was accepted, only an empty one goes.
      ...(expectedMarker !== undefined ? { requireMarker: true } : {}),
      ...(rootBefore.identity ? { expectedRoot: rootBefore.identity } : {})
    }
  }
  if (
    forbidAnyMarker ||
    before.kind !== 'file' ||
    (expectedMarker !== undefined && before.identity !== expectedMarker)
  ) {
    throw differentCheckoutAtPathError(path)
  }
  const safe = await provesLocalOrphanedWorktree(path, repoPath, opts, CLIENT_REMOVAL_HOME, [
    runtimePath,
    runtimeRepoPath
  ])
  throwIfSignalAborted(signal)
  if (!safe) {
    throw differentCheckoutAtPathError(path)
  }
  const rootAfter = await readCheckoutRootState(path, opts)
  throwIfSignalAborted(signal)
  if (rootAfter.kind === 'absent') {
    return null
  }
  const after = await readCheckoutMarkerState(path, opts)
  throwIfSignalAborted(signal)
  if (
    rootAfter.kind !== 'directory' ||
    (rootBefore.identity && rootAfter.identity && rootAfter.identity !== rootBefore.identity)
  ) {
    throw differentCheckoutAtPathError(path)
  }
  const expectedRoot = rootAfter.identity ?? rootBefore.identity
  if (after.kind === 'absent') {
    return { forbidAnyMarker: true, requireMarker: true, ...(expectedRoot ? { expectedRoot } : {}) }
  }
  if (after.kind !== 'file' || after.identity !== before.identity) {
    throw differentCheckoutAtPathError(path)
  }
  return {
    expectedMarker: before.identity,
    requireMarker: true,
    ...(expectedRoot ? { expectedRoot } : {})
  }
}

async function isRecoverablePartialRemovalFailure(
  args: LocalPartialRemovalRecoveryArgs
): Promise<boolean> {
  // Leave English orphan errors (Git refused before deleting) to the proven-orphan cleanup.
  if (
    typeof args.error !== 'object' ||
    args.error === null ||
    isOrphanedWorktreeError(args.error)
  ) {
    return false
  }

  let worktrees: GitWorktreeInfo[]
  try {
    worktrees = await listWorktreesStrict(args.repoPath, args.localWorktreeGitOptions)
  } catch {
    return false
  }
  // Localized error text cannot prove removal started; require the Git row to be absent.
  if (
    worktrees.some((worktree) => areWorktreePathsEqual(worktree.path, args.canonicalWorktreePath))
  ) {
    return false
  }
  // A worktree registered inside the checkout during Git's delete must not be removed with it.
  assertWorktreeDoesNotContainRegisteredWorktree(args.canonicalWorktreePath, worktrees)
  return true
}
