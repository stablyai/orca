import { assertGitPushTargetShape } from '../shared/git-push-target-validation'
import {
  resolveConfiguredGitPushTarget,
  type ResolvedGitPushTarget
} from '../shared/git-push-target-resolution'
import type { GitPushTarget } from '../shared/worktree/types'

type RelayGit = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>

export async function resolveRelayPushTarget(
  git: RelayGit,
  worktreePath: string,
  pushTarget: unknown
): Promise<ResolvedGitPushTarget | null> {
  if (pushTarget === undefined) {
    return resolveConfiguredGitPushTarget((args) => git(args, worktreePath))
  }
  assertGitPushTargetShape(pushTarget)
  const explicitTarget: GitPushTarget = pushTarget
  // Why here and not in the shared resolver: an explicit target arrives over the wire,
  // so the host re-validates its shape and asks Git to vet the branch name itself.
  await git(['check-ref-format', '--branch', explicitTarget.branchName], worktreePath)
  return {
    remote: explicitTarget.remoteName,
    refspec: `HEAD:${explicitTarget.branchName}`
  }
}
