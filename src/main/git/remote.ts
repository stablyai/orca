import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { resolveEffectiveGitUpstream } from '../../shared/git-effective-upstream'
import { gitRefTargetsBranchOnRemote } from '../../shared/git-remote-branch-name'
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

    const [pushRemote, { stdout: mergeStdout }] = await Promise.all([
      getConfiguredPushRemote(worktreePath, branch),
      gitExecFileAsync(['config', '--get', `branch.${branch}.merge`], { cwd: worktreePath })
    ])
    const remote = pushRemote?.remote
    const mergeRef = mergeStdout.trim()
    const branchRef = mergeRef.replace(/^refs\/heads\//, '')
    if (!remote || !branchRef || remote === '.' || branchRef === mergeRef) {
      return null
    }
    if (await branchMergeTargetsConfiguredBase(worktreePath, branch, remote, branchRef)) {
      return null
    }
    if (!canPushConfiguredMergeBranch(pushRemote, branch, branchRef)) {
      return null
    }
    return { remote, refspec: `HEAD:${branchRef}` }
  } catch {
    return null
  }
}

async function getConfigValue(worktreePath: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(['config', '--get', key], { cwd: worktreePath })
    const value = stdout.trim()
    return value || null
  } catch {
    return null
  }
}

function isUrlValuedRemote(remote: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote) || /^[^@/:]+@[^:]+:.+/.test(remote)
}

type ConfiguredPushRemote = {
  remote: string
  branchRemote: string | null
}

async function findRemoteNameForUrl(
  worktreePath: string,
  remoteUrl: string
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(['remote'], { cwd: worktreePath })
    const remotes = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const remoteName of remotes) {
      try {
        const { stdout: urlStdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
          cwd: worktreePath
        })
        if (urlStdout.trim() === remoteUrl) {
          return remoteName
        }
      } catch {
        // Ignore a remote that disappeared or has no fetch URL.
      }
    }
  } catch {
    return null
  }
  return null
}

async function normalizePushRemote(worktreePath: string, remote: string): Promise<string> {
  if (!isUrlValuedRemote(remote)) {
    return remote
  }
  return (await findRemoteNameForUrl(worktreePath, remote)) ?? remote
}

async function getConfiguredPushRemote(
  worktreePath: string,
  branch: string
): Promise<ConfiguredPushRemote | null> {
  const branchRemote = await getConfigValue(worktreePath, `branch.${branch}.remote`)
  const remote =
    (await getConfigValue(worktreePath, `branch.${branch}.pushRemote`)) ??
    (await getConfigValue(worktreePath, 'remote.pushDefault')) ??
    branchRemote
  if (!remote) {
    return null
  }
  return {
    remote: await normalizePushRemote(worktreePath, remote),
    branchRemote: branchRemote ? await normalizePushRemote(worktreePath, branchRemote) : null
  }
}

async function branchMergeTargetsConfiguredBase(
  worktreePath: string,
  branch: string,
  remote: string,
  branchRef: string
): Promise<boolean> {
  return gitRefTargetsBranchOnRemote(
    await getConfigValue(worktreePath, `branch.${branch}.base`),
    remote,
    branchRef
  )
}

function canPushConfiguredMergeBranch(
  pushRemote: ConfiguredPushRemote | null,
  branch: string,
  branchRef: string
): boolean {
  if (!pushRemote) {
    return false
  }
  if (branchRef === branch) {
    return true
  }
  // Why: branch.merge belongs to branch.remote. A pushDefault fork must not
  // inherit origin/main as its destination branch.
  return pushRemote.remote !== 'origin' && pushRemote.branchRemote === pushRemote.remote
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
  // Why: plain `git pull` honors the user's configured merge/rebase/ff policy.
  // If no policy exists, Git's policy error is normalized with setup guidance.
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
