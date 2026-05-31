import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { resolveEffectiveGitUpstream } from '../../shared/git-effective-upstream'
import { resolveGitRemoteRebaseSource } from '../../shared/git-rebase-source'
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
  pushTarget?: GitPushTarget,
  options: { forceWithLease?: boolean } = {}
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
    const args = [
      'push',
      ...(options.forceWithLease ? ['--force-with-lease'] : []),
      '--set-upstream',
      ...(target ? [target.remote, target.refspec] : ['origin', 'HEAD'])
    ]
    await gitExecFileAsync(args, { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}

async function gitPullWithArgs(
  worktreePath: string,
  pullArgs: string[],
  pushTarget?: GitPushTarget
): Promise<void> {
  try {
    if (pushTarget) {
      const target = await validateGitPushTarget(worktreePath, pushTarget)
      await gitExecFileAsync(['pull', ...pullArgs, target.remoteName, target.branchName], {
        cwd: worktreePath
      })
      return
    }
    const upstream = await resolveEffectiveGitUpstream((args) =>
      gitExecFileAsync(args, { cwd: worktreePath })
    )
    if (upstream && !upstream.isConfiguredUpstream) {
      // Why: legacy Orca branches may still track origin/main while pushes
      // target origin/<branch>. Pull the same effective branch the UI reports.
      await gitExecFileAsync(['pull', ...pullArgs, upstream.remoteName, upstream.branchName], {
        cwd: worktreePath
      })
      return
    }

    await gitExecFileAsync(['pull', ...pullArgs], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'pull'))
  }
}

export async function gitPull(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
  // Why: plain `git pull` uses the user's configured pull strategy (merge by
  // default) so diverged branches reconcile instead of erroring out. Conflicts
  // surface through the existing conflict-resolution flow.
  await gitPullWithArgs(worktreePath, [], pushTarget)
}

export async function gitFastForward(
  worktreePath: string,
  pushTarget?: GitPushTarget
): Promise<void> {
  await gitPullWithArgs(worktreePath, ['--ff-only'], pushTarget)
}

export async function gitPullRebaseFromBase(worktreePath: string, baseRef: string): Promise<void> {
  try {
    const source = await resolveGitRemoteRebaseSource(
      (args) => gitExecFileAsync(args, { cwd: worktreePath }),
      baseRef
    )
    await gitExecFileAsync(['pull', '--rebase', source.remoteName, source.branchName], {
      cwd: worktreePath
    })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'pull'))
  }
}

export async function gitFetch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
  try {
    if (pushTarget) {
      const target = await validateGitPushTarget(worktreePath, pushTarget)
      await gitExecFileAsync(['fetch', '--prune', target.remoteName], { cwd: worktreePath })
      return
    }
    await gitExecFileAsync(['fetch', '--prune'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'fetch'))
  }
}
