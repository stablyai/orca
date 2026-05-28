import { assertGitPushTargetShape } from '../shared/git-push-target-validation'
import type { GitPushTarget } from '../shared/types'

type RelayGit = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>

export type ResolvedPushTarget = {
  remote: string
  refspec: string
}

async function getConfiguredPushTarget(
  git: RelayGit,
  worktreePath: string
): Promise<ResolvedPushTarget | null> {
  try {
    const { stdout: branchStdout } = await git(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      worktreePath
    )
    const branch = branchStdout.trim()
    if (!branch) {
      return null
    }
    const [{ stdout: remoteStdout }, { stdout: mergeStdout }] = await Promise.all([
      git(['config', '--get', `branch.${branch}.remote`], worktreePath),
      git(['config', '--get', `branch.${branch}.merge`], worktreePath)
    ])
    const remote = remoteStdout.trim()
    const mergeRef = mergeStdout.trim()
    const branchRef = mergeRef.replace(/^refs\/heads\//, '')
    if (!remote || !branchRef || remote === '.' || branchRef === mergeRef) {
      return null
    }
    if (remote === 'origin' && branchRef !== branch) {
      return null
    }
    return { remote, refspec: `HEAD:${branchRef}` }
  } catch {
    return null
  }
}

export async function resolveRelayPushTarget(
  git: RelayGit,
  worktreePath: string,
  pushTarget: unknown
): Promise<ResolvedPushTarget | null> {
  if (pushTarget === undefined) {
    return getConfiguredPushTarget(git, worktreePath)
  }
  assertGitPushTargetShape(pushTarget)
  const explicitTarget: GitPushTarget = pushTarget
  await git(['check-ref-format', '--branch', explicitTarget.branchName], worktreePath)
  return {
    remote: explicitTarget.remoteName,
    refspec: `HEAD:${explicitTarget.branchName}`
  }
}
