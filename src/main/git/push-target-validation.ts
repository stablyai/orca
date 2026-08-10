import type { GitPushTarget } from '../../shared/types'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

export async function validateGitPushTarget(
  repoPath: string,
  target: unknown,
  options: GitRuntimeOptions = {}
): Promise<GitPushTarget> {
  assertGitPushTargetShape(target)
  await gitExecFileAsync(
    ['check-ref-format', '--branch', target.branchName],
    gitOptionsForWorktree(repoPath, options)
  )
  return target
}
