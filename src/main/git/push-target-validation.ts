import type { GitPushTarget } from '../../shared/types'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { gitExecFileAsync } from './runner'

type GitExecOptions = {
  wslDistro?: string
}

export async function validateGitPushTarget(
  repoPath: string,
  target: unknown,
  options: GitExecOptions = {}
): Promise<GitPushTarget> {
  assertGitPushTargetShape(target)
  await gitExecFileAsync(['check-ref-format', '--branch', target.branchName], {
    cwd: repoPath,
    ...options
  })
  return target
}
