import { throwIfSignalAborted } from '../../../../shared/concurrency/abort-signal-reason'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { finishUnregisteredWorktreeRemoval } from '../../../git/worktrees/removal/worktree-removal'
import type { WorktreeRemovalExpectation } from '../../../workspaces/removal/worktree-removal-expectation'
import {
  cleanupRemovedWorktreePushTarget,
  type RuntimeLocalWorktreeRemovalFinishArgs
} from './runtime-registered-local-worktree-removal'
import type { InterruptedLocalWorktreeRemovalArgs } from './runtime-interrupted-local-worktree-removal-types'

/** Prunes Git's registration and cleans up the branch, never deleting files: anything that
 * appears at the path meanwhile is refused unless it is the reviewed checkout. */
export async function finishGoneCheckoutBookkeeping(
  args: InterruptedLocalWorktreeRemovalArgs,
  expectation: WorktreeRemovalExpectation,
  finishArgs: RuntimeLocalWorktreeRemovalFinishArgs
): Promise<RemoveWorktreeResult> {
  const { record } = args
  const assertStillGone = () => expectation.assertCheckoutStillGone(record.worktreePath)
  await assertStillGone()
  throwIfSignalAborted(args.stopSignal)
  const gate = await args.acquireWatcherRemoval(record.worktreePath)
  let result: RemoveWorktreeResult
  let finished = false
  try {
    throwIfSignalAborted(args.stopSignal)
    await args.stopPtys?.()
    throwIfSignalAborted(args.stopSignal)
    const branch =
      record.deleteBranch && record.branch ? { name: record.branch, head: record.head } : null
    result = await finishUnregisteredWorktreeRemoval(
      finishArgs.repo.path,
      record.worktreePath,
      branch,
      assertStillGone,
      finishArgs.localOptions
    )
    // Completion: re-check fresh, since the bookkeeping awaited Git.
    await assertStillGone()
    finished = true
  } finally {
    await gate.finish(finished)
  }
  await cleanupRemovedWorktreePushTarget(finishArgs)
  await args.finishRemoval(result, true, record.head)
  return result
}
