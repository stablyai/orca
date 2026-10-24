/**
 * Merge a task worktree's branch (including its uncommitted changes) into the
 * main checkout *without committing*, so the user can review it there and then
 * accept (commit) or reject (undo).
 *
 * Nothing is persisted: "awaiting review" is just `MERGE_HEAD` in the main
 * checkout, and the main checkout's own changes are parked in a stash whose
 * subject carries the merge-review marker — the same marker the standalone `wf`
 * tool uses, so the two interoperate on one state.
 */
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import {
  WORKTREE_MERGE_REVIEW_MAIN_WORKTREE_UNSUPPORTED_MESSAGE,
  WORKTREE_MERGE_REVIEW_WSL_SYNC_UNSUPPORTED_MESSAGE,
  findConflictMarkerPaths,
  parseUnstagedWorktreePaths,
  parseWorktreeMergeReviewBranch,
  type WorktreeMergeReviewAcceptOutcome,
  type WorktreeMergeReviewRejectOutcome,
  type WorktreeMergeReviewState,
  type WorktreeMergeReviewSyncOutcome
} from '../../shared/git-merge-review'
import {
  collectHandEdits,
  createMergeReviewGit,
  currentBranch,
  hasParkedStash,
  indent,
  isMergePending,
  parkMainChanges,
  restoreStash,
  snapshotUncommittedChanges,
  trackedChanges,
  unmergedFiles,
  type WorktreeMergeReviewGitOptions
} from './worktree-merge-review-git'
import { readWorktreeList } from './worktree-list-reader'
import { areWorktreePathsEqual } from './worktree-path-comparison'
import { runWithGitReadCacheInvalidation } from './source-control/git-read-cache-invalidation'
import { resolveGitDir } from './source-control/resolve-git-dir'

export type { WorktreeMergeReviewGitOptions } from './worktree-merge-review-git'

/** Main checkout of the repository owning `worktreePath`, per Git's own worktree list. */
export async function resolveMainWorktreePath(
  worktreePath: string,
  options: WorktreeMergeReviewGitOptions = {}
): Promise<string> {
  const worktrees = await readWorktreeList(worktreePath, {
    ...options,
    admissionTier: 'interactive'
  })
  const main = worktrees.find((worktree) => worktree.isMainWorktree)
  if (!main || main.isBare) {
    throw new Error(WORKTREE_MERGE_REVIEW_MAIN_WORKTREE_UNSUPPORTED_MESSAGE)
  }
  return main.path
}

export async function getWorktreeMergeReviewState(
  mainWorktreePath: string,
  options: WorktreeMergeReviewGitOptions = {}
): Promise<WorktreeMergeReviewState> {
  if (!(await isMergePending(mainWorktreePath, options))) {
    return { phase: 'idle', syncSupported: !options.wslDistro }
  }
  const git = createMergeReviewGit(mainWorktreePath, options)
  const [conflicts, mergeMessage] = await Promise.all([
    unmergedFiles(git),
    readFile(path.join(await resolveGitDir(mainWorktreePath, options), 'MERGE_MSG'), 'utf-8').catch(
      () => ''
    )
  ])
  return {
    phase: 'pending',
    branch: parseWorktreeMergeReviewBranch(mergeMessage),
    conflicts
  }
}

export async function syncWorktreeToMain(
  args: { worktreePath: string; mainWorktreePath: string },
  options: WorktreeMergeReviewGitOptions = {}
): Promise<WorktreeMergeReviewSyncOutcome> {
  // Why: the snapshot points GIT_INDEX_FILE at a host temp file, and WSL does not
  // forward that variable — Git there would stage into the worktree's real index.
  if (options.wslDistro) {
    throw new Error(WORKTREE_MERGE_REVIEW_WSL_SYNC_UNSUPPORTED_MESSAGE)
  }
  const { worktreePath, mainWorktreePath } = args
  if (areWorktreePathsEqual(worktreePath, mainWorktreePath)) {
    throw new Error('Merge review starts from a task worktree, not from the main checkout.')
  }
  const atWorktree = createMergeReviewGit(worktreePath, options)
  const atMain = createMergeReviewGit(mainWorktreePath, options)

  const branch = await currentBranch(atWorktree)
  if (!branch) {
    throw new Error('The task worktree is on a detached HEAD; check out its branch first.')
  }
  const targetBranch = await currentBranch(atMain)
  if (!targetBranch) {
    throw new Error(
      'The main checkout is on a detached HEAD; check out the branch to merge into first.'
    )
  }
  if (await isMergePending(mainWorktreePath, options)) {
    throw new Error(
      'The main checkout already has a merge awaiting review; accept or reject it first.'
    )
  }
  if (await hasParkedStash(atMain)) {
    throw new Error('The main checkout has an unrestored auto-stash; restore it before syncing.')
  }
  const mainConflicts = await unmergedFiles(atMain)
  if (mainConflicts.length > 0) {
    throw new Error(`The main checkout has unresolved conflicts:\n${indent(mainConflicts)}`)
  }

  return runWithGitReadCacheInvalidation(async () => {
    const snapshot = await snapshotUncommittedChanges(atWorktree, worktreePath, options, branch)
    const source = snapshot ?? branch
    if ((await atMain.attempt(['merge-base', '--is-ancestor', source, 'HEAD'])).ok) {
      return { kind: 'nothing-to-merge', branch, targetBranch }
    }
    // Why: accepting leaves the worktree's uncommitted changes in place, so the
    // next sync snapshots the same tree under a new commit id. That commit is not
    // an ancestor, and --no-ff would open a review with an empty diff.
    if (snapshot && (await atMain.attempt(['diff', '--quiet', 'HEAD', snapshot])).ok) {
      return { kind: 'nothing-to-merge', branch, targetBranch }
    }

    const stashedMainChanges = (await trackedChanges(atMain)).length > 0
    if (stashedMainChanges) {
      await parkMainChanges(atMain, branch)
    }

    const merge = await atMain.attempt([
      'merge',
      '--no-ff',
      '--no-commit',
      '-m',
      `Merge branch '${branch}'`,
      source
    ])
    if (!(await isMergePending(mainWorktreePath, options))) {
      // The merge never started (e.g. an untracked file in the main checkout is in the way).
      if (stashedMainChanges) {
        await restoreStash(atMain)
      }
      throw new Error(
        `The merge could not start; the main checkout is unchanged:\n${merge.stderr || merge.stdout}`
      )
    }

    const conflicts = await unmergedFiles(atMain)
    return {
      kind: 'merged',
      branch,
      targetBranch,
      stat: conflicts.length > 0 ? '' : await atMain.output(['diff', '--cached', '--stat', 'HEAD']),
      conflicts,
      includedUncommittedChanges: snapshot !== null,
      stashedMainChanges
    }
  })
}

export async function acceptWorktreeMerge(
  mainWorktreePath: string,
  options: WorktreeMergeReviewGitOptions = {},
  message?: string
): Promise<WorktreeMergeReviewAcceptOutcome> {
  const atMain = createMergeReviewGit(mainWorktreePath, options)
  if (!(await isMergePending(mainWorktreePath, options))) {
    // Already committed by hand in the main checkout: only the parked changes remain.
    if (await restoreStash(atMain)) {
      return { kind: 'stash-restored' }
    }
    throw new Error('There is no merge awaiting review.')
  }

  const conflicts = await unmergedFiles(atMain)
  if (conflicts.length > 0) {
    throw new Error(
      `Unresolved conflicts remain; resolve and stage them first:\n${indent(conflicts)}`
    )
  }
  const unstaged = parseUnstagedWorktreePaths(
    await atMain.output(['status', '--porcelain', '-z', '--untracked-files=no'])
  )
  if (unstaged.length > 0) {
    throw new Error(
      `These files have unstaged changes; stage them into the merge or discard them first:\n${indent(unstaged)}`
    )
  }
  const markers = findConflictMarkerPaths(
    await atMain.output(['diff', '--cached', '--no-color', '--no-ext-diff', '-U0', 'HEAD'])
  )
  if (markers.length > 0) {
    throw new Error(
      `Conflict markers remain in these files; resolve and stage them first:\n${indent(markers)}`
    )
  }

  return runWithGitReadCacheInvalidation(async () => {
    await atMain.output(message === undefined ? ['commit', '--no-edit'] : ['commit', '-m', message])
    const summary = await atMain.output(['log', '-1', '--format=%h %s'])
    await restoreStash(atMain)
    return { kind: 'committed', summary }
  })
}

export async function rejectWorktreeMerge(
  mainWorktreePath: string,
  options: WorktreeMergeReviewGitOptions = {},
  assumeYes = false
): Promise<WorktreeMergeReviewRejectOutcome> {
  const atMain = createMergeReviewGit(mainWorktreePath, options)
  if (!(await isMergePending(mainWorktreePath, options))) {
    if (await restoreStash(atMain)) {
      return { kind: 'stash-restored' }
    }
    throw new Error('There is no merge awaiting review.')
  }

  const handEdits = await collectHandEdits(atMain, mainWorktreePath, options)
  if (handEdits.length > 0 && !assumeYes) {
    return { kind: 'needs-confirmation', paths: handEdits }
  }

  return runWithGitReadCacheInvalidation(async () => {
    if (handEdits.length > 0) {
      // Why: `merge --abort` keeps edits made during review, contradicting what the confirmation promised to discard.
      await atMain.output(['reset', '--hard', 'HEAD'])
    } else {
      const abort = await atMain.attempt(['merge', '--abort'])
      if (!abort.ok) {
        // Nothing outside the merge is dirty here, so the fallback discards only merged content.
        await atMain.output(['reset', '--hard', 'HEAD'])
      }
    }
    await restoreStash(atMain)
    return { kind: 'rejected' }
  })
}
