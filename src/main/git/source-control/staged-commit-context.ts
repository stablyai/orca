import type { CommitMessageDraftContext } from '../../../shared/commit-message-generation'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { describeMaxBufferOverflowError, isMaxBufferOverflowError } from '../max-buffer-overflow'
import { MAX_STAGED_COMMIT_CONTEXT_BYTES } from './git-show-max-bytes'

export async function getStagedCommitContext(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<CommitMessageDraftContext | null> {
  const branchPromise = gitExecFileAsync(['branch', '--show-current'], {
    ...gitOptionsForWorktree(worktreePath, options)
  }).catch(() => ({ stdout: '' }))
  const summaryPromise = gitExecFileAsync(['diff', '--cached', '--name-status'], {
    ...gitOptionsForWorktree(worktreePath, options),
    maxBuffer: MAX_STAGED_COMMIT_CONTEXT_BYTES
  })

  const [branchResult, summaryResult] = await Promise.all([branchPromise, summaryPromise])
  const stagedSummary = summaryResult.stdout.trim()
  if (!stagedSummary) {
    return null
  }

  let stagedPatch = ''
  try {
    const patchResult = await gitExecFileAsync(
      ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff'],
      {
        ...gitOptionsForWorktree(worktreePath, options),
        maxBuffer: MAX_STAGED_COMMIT_CONTEXT_BYTES
      }
    )
    stagedPatch = patchResult.stdout
  } catch (error) {
    if (!isMaxBufferOverflowError(error)) {
      throw error
    }
    // Why: staged patch is optional context (truncated later anyway); degrade to file-name summary rather than fail.
    console.warn(
      '[git] Staged patch too large to read; using file summary only:',
      describeMaxBufferOverflowError(error)
    )
  }

  return {
    branch: branchResult.stdout.trim() || null,
    stagedSummary,
    stagedPatch
  }
}
