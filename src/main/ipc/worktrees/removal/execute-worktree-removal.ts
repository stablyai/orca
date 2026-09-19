import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { listWorktreesStrict as listGitWorktreesStrict } from '../../../git/worktree'
import { requireSshGitProvider } from '../../../providers/ssh-git-dispatch'
import { resolveWorktreeRemovalMetadata } from '../../../worktree-removal-repo-owner'
import { isPrunableGitFileWorktree } from '../../../worktree-prunable-git-file'
import { findRegisteredDeletableWorktree } from '../../../worktree-removal-safety'
import { removeStaleLocalWorktreeRegistration } from '../../../local-worktree-removal-recovery'
import { resolveWorktreeRemovalHomeForHost } from '../../../worktree-removal-execution-host-route'
import { runHook } from '../../../hooks'
import type { ArchiveHookOverride } from '../../../../shared/worktree/archive-hook-removal-gate'
import { gateWorktreeRemovalOnArchiveHook } from '../../../worktree-archive-hook-gate'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import {
  cleanupUnusedWorktreePushTargetRemote,
  notifyWorktreesChanged
} from '../../worktree-remote'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
import { formatWorktreeRemovalError } from '../../worktree-logic'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { getArchiveHooksForRemoval, runRemoteArchiveHook } from './worktree-archive-hook'
import { isAlreadyRemovedWorktreePath } from './worktree-removal-filesystem'
import { rememberPreservedBranchCleanupTarget } from './preserved-branch-cleanup'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'
import { removeFolderWorkspace } from './remove-folder-workspace'
import { removeUnregisteredWorktree } from './remove-unregistered-worktree'
import { removeRegisteredRemoteWorktree } from './remove-registered-remote-worktree'
import { removeRegisteredLocalWorktree } from './remove-registered-local-worktree'

/**
 * Refuses a repo row whose two host spellings disagree.
 *
 * Everything below picks the filesystem it deletes on from `repo.connectionId`, while the metadata
 * prune, the archive-hook route and the home authority all come from `removalHostId`. A row naming
 * `executionHostId: 'ssh:<target>'` with no `connectionId` therefore lists and deletes a same-named
 * path on THIS machine while the guards vouch for the remote one, and the reverse row does the
 * mirror image (#11163). Neither spelling is evidence about the other, so refuse instead of picking
 * a winner: the worktree is left in place, which is the recoverable outcome
 * (docs/reference/ssh-execution-boundary.md).
 */
function assertRemovalHostMatchesRepoRow(
  repo: Repo,
  repoId: string,
  removalHostId: ExecutionHostId
): void {
  const repoRowHostId = getRepoExecutionHostId({
    connectionId: repo.connectionId,
    executionHostId: null
  })
  // `repoRowHostId` is built from `connectionId`, so it is always `local` or an `ssh:` id and its
  // name is never `null`. An unroutable `removalHostId` can therefore only ever be the left operand,
  // and `null` matches no name — which is how `runtime:<env>` is refused here.
  if (removalHostName(removalHostId) !== removalHostName(repoRowHostId)) {
    throw new Error(
      `Refusing to delete worktree: repo ${repoId} names execution host ${removalHostId}, but its checkout is only reachable as ${repoRowHostId}.`
    )
  }
}

/**
 * The machine a host id names, or `null` for one this path cannot delete on.
 *
 * Compared after decoding rather than as stored text: `ssh:my target` and `ssh:my%20target` are the
 * same host, and refusing a removal over the spelling of a percent-escape would be a false alarm on
 * a row that is perfectly consistent. `runtime:<env>` and an unparseable id name no machine this
 * path can delete on, so they answer `null` and the caller refuses them outright.
 */
function removalHostName(hostId: ExecutionHostId): string | null {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'local') {
    return 'local'
  }
  return parsed?.kind === 'ssh' ? `ssh:${parsed.targetId}` : null
}

export async function executeWorktreeRemoval(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  repo: Repo,
  repoId: string,
  worktreePath: string,
  removalHostId: ExecutionHostId
): Promise<RemoveWorktreeResult> {
  const { mainWindow, store, runtime } = context
  if (isFolderRepo(repo)) {
    return removeFolderWorkspace(context, args, repo, repoId, removalHostId)
  }
  assertRemovalHostMatchesRepoRow(repo, repoId, removalHostId)
  const provider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
  const localWorktreeGitOptions = repo.connectionId
    ? {}
    : getLocalProjectWorktreeGitOptions(store, repo)
  const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
  const registeredWorktrees = repo.connectionId
    ? await provider!.listWorktrees(repo.path)
    : hasLocalWorktreeGitOptions
      ? await listGitWorktreesStrict(repo.path, localWorktreeGitOptions)
      : await listGitWorktreesStrict(repo.path)
  const removedMeta = resolveWorktreeRemovalMetadata(store, repoId, args.worktreeId, removalHostId)
  const removedPushTarget = removedMeta?.pushTarget
  const registeredWorktree = findRegisteredDeletableWorktree(
    repo.path,
    worktreePath,
    registeredWorktrees,
    resolveWorktreeRemovalHomeForHost(removalHostId)
  )
  if (!registeredWorktree) {
    return removeUnregisteredWorktree(
      context,
      args,
      repo,
      repoId,
      worktreePath,
      removalHostId,
      registeredWorktrees,
      removedMeta,
      removedPushTarget,
      localWorktreeGitOptions,
      provider
    )
  }
  const canonicalWorktreePath = registeredWorktree.path

  const deleteBranch = removedMeta?.preserveBranchOnDelete !== true

  try {
    assertWorktreeUnlockedForRemoval(registeredWorktree)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false))
  }

  // Ahead of the archive-hook gate below, and that ordering is right: both arms describe a
  // registration with no checkout behind it — a row whose path IS a `.git` file, or a tree already
  // gone from disk. There is nothing to archive, and running the hook would fail on the missing
  // cwd and block a cleanup that has no user data to lose.
  if (
    !repo.connectionId &&
    ((await isPrunableGitFileWorktree(registeredWorktree, localWorktreeGitOptions)) ||
      (args.force === true &&
        process.platform === 'win32' &&
        (isWindowsAbsolutePathLike(canonicalWorktreePath) || !!localWorktreeGitOptions.wslDistro) &&
        removedMeta &&
        (await isAlreadyRemovedWorktreePath(repo, canonicalWorktreePath, localWorktreeGitOptions))))
  ) {
    const removalResult = await removeStaleLocalWorktreeRegistration({
      canonicalWorktreePath,
      repoPath: repo.path,
      localWorktreeGitOptions,
      registeredWorktree,
      deleteBranch
    })
    await cleanupUnusedWorktreePushTargetRemote(
      repo.path,
      args.worktreeId,
      removedPushTarget,
      store,
      localWorktreeGitOptions
    )
    rememberPreservedBranchCleanupTarget(
      args.worktreeId,
      removalHostId,
      removalResult,
      registeredWorktree.head,
      removedPushTarget
    )
    runtime.clearOptimisticReconcileToken(args.worktreeId)
    removeWorktreeMetadataAndTransientState(
      store,
      args.worktreeId,
      removalHostId,
      args.snapshotPruneBatchId
    )
    invalidateAuthorizedRootsCache()
    notifyWorktreesChanged(mainWindow, repoId)
    return removalResult ?? {}
  }

  // No connectionId override here, deliberately: this path derives its host from the repo row
  // (`getRepoExecutionHostId` in register-worktree-removal-handlers) and resolves its provider, git
  // options, listing and dispatch from `repo.connectionId` alone. Passing a different owner to the
  // hook reader would read one host's orca.yaml while running the other host's git. The runtime's
  // SSH path is the one that carries a route owner separate from the row, and it passes it.
  const hooks = await getArchiveHooksForRemoval(repo)

  const archiveScript = hooks?.scripts.archive

  // Precondition, not an advisory (#19334): both branches below stop PTYs and delete the
  // checkout, so a hook failure has to throw here — before either is reached.
  let archiveHookOverride: ArchiveHookOverride | undefined
  if (archiveScript && !args.skipArchive) {
    // Why the branch on connectionId: this block is shared by both flows, so a hardcoded
    // 'remote' would file every local archive hook under the SSH breakdown.
    await withWorktreeRemoveStageSpan(
      'archive_hook',
      repo.connectionId ? 'remote' : 'local',
      async () => {
        const result = repo.connectionId
          ? await runRemoteArchiveHook(
              repo,
              repo.connectionId,
              canonicalWorktreePath,
              archiveScript
            )
          : await runHook(
              'archive',
              canonicalWorktreePath,
              repo,
              undefined,
              localWorktreeGitOptions
            )
        archiveHookOverride = gateWorktreeRemovalOnArchiveHook({
          worktreePath: canonicalWorktreePath,
          result,
          allowFailure: args.allowFailedArchiveHook === true
        })
      }
    )
  }

  const remoteConnectionId = repo.connectionId ?? undefined
  const result = remoteConnectionId
    ? await removeRegisteredRemoteWorktree(
        context,
        args,
        repo,
        repoId,
        canonicalWorktreePath,
        removalHostId,
        registeredWorktree,
        removedPushTarget,
        provider!,
        deleteBranch
      )
    : await removeRegisteredLocalWorktree(
        context,
        args,
        repo,
        repoId,
        canonicalWorktreePath,
        removalHostId,
        removedPushTarget,
        localWorktreeGitOptions,
        hasLocalWorktreeGitOptions,
        deleteBranch
      )
  return archiveHookOverride ? { ...result, archiveHookOverride } : result
}
