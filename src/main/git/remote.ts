import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import type { GitPushTarget } from '../../shared/types'
import { validateGitPushTarget } from './push-target-validation'
import { gitExecFileAsync } from './runner'

async function getConfiguredPushTarget(
  worktreePath: string
): Promise<{ remote: string; refspec: string } | null> {
  try {
    const { stdout: branchStdout } = await gitExecFileAsync(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { cwd: worktreePath }
    )
    const branch = branchStdout.trim()
    if (!branch) {
      return null
    }

    const [{ stdout: remoteStdout }, { stdout: mergeStdout }] = await Promise.all([
      gitExecFileAsync(['config', '--get', `branch.${branch}.remote`], { cwd: worktreePath }),
      gitExecFileAsync(['config', '--get', `branch.${branch}.merge`], { cwd: worktreePath })
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

function explicitPushTarget(target: GitPushTarget): { remote: string; refspec: string } {
  return { remote: target.remoteName, refspec: `HEAD:${target.branchName}` }
}

export async function gitPush(
  worktreePath: string,
  _publish = false,
  pushTarget?: GitPushTarget
): Promise<void> {
  try {
    if (pushTarget) {
      await validateGitPushTarget(worktreePath, pushTarget)
    }
    // Why: push to the branch's configured upstream when one exists. PR-created
    // worktrees can track a contributor fork remote; hardcoding origin here
    // would send review commits to the upstream repository instead.
    //
    // When no upstream exists, keep the existing first-publish behavior:
    // create/update origin/<current branch> and set it as upstream.
    //
    // Branch-vs-base reporting (the "Committed on Branch" section) is
    // unaffected because it uses branchCompare against an explicit baseRef
    // from worktree config, not the upstream relationship.
    const target = pushTarget
      ? explicitPushTarget(pushTarget)
      : await getConfiguredPushTarget(worktreePath)
    const args = target
      ? ['push', '--set-upstream', target.remote, target.refspec]
      : ['push', '--set-upstream', 'origin', 'HEAD']
    await gitExecFileAsync(args, { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}

export async function gitPull(worktreePath: string): Promise<void> {
  // Why: plain `git pull` uses the user's configured pull strategy (merge by
  // default) so diverged branches reconcile instead of erroring out. Conflicts
  // surface through the existing conflict-resolution flow.
  try {
    await gitExecFileAsync(['pull'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'pull'))
  }
}

export async function gitFetch(worktreePath: string): Promise<void> {
  try {
    await gitExecFileAsync(['fetch', '--prune'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'fetch'))
  }
}
