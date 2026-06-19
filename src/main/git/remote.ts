import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { resolveEffectiveGitUpstream } from '../../shared/git-effective-upstream'
import { gitRefTargetsBranchOnRemote } from '../../shared/git-remote-branch-name'
import { resolveGitRemoteRebaseSource } from '../../shared/git-rebase-source'
import type { GitPushTarget } from '../../shared/types'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { validateGitPushTarget } from './push-target-validation'
import { gitExecFileAsync } from './runner'

async function getConfiguredPushTarget(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<{ remote: string; refspec: string } | null> {
  try {
    const { stdout: branchStdout } = await gitExecFileAsync(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      gitOptionsForWorktree(worktreePath, options)
    )
    const branch = branchStdout.trim()
    if (!branch) {
      return null
    }

    const [pushRemote, { stdout: mergeStdout }] = await Promise.all([
      getConfiguredPushRemote(worktreePath, branch, options),
      gitExecFileAsync(
        ['config', '--get', `branch.${branch}.merge`],
        gitOptionsForWorktree(worktreePath, options)
      )
    ])
    const remote = pushRemote?.remote
    const mergeRef = mergeStdout.trim()
    const branchRef = mergeRef.replace(/^refs\/heads\//, '')
    if (!remote || !branchRef || remote === '.' || branchRef === mergeRef) {
      return null
    }
    if (await branchMergeTargetsConfiguredBase(worktreePath, branch, remote, branchRef, options)) {
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

async function getConfigValue(
  worktreePath: string,
  key: string,
  options: GitRuntimeOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '--get', key],
      gitOptionsForWorktree(worktreePath, options)
    )
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
  remoteUrl: string,
  options: GitRuntimeOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['remote'],
      gitOptionsForWorktree(worktreePath, options)
    )
    const remotes = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const remoteName of remotes) {
      try {
        const { stdout: urlStdout } = await gitExecFileAsync(
          ['remote', 'get-url', remoteName],
          gitOptionsForWorktree(worktreePath, options)
        )
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

async function normalizePushRemote(
  worktreePath: string,
  remote: string,
  options: GitRuntimeOptions = {}
): Promise<string> {
  if (!isUrlValuedRemote(remote)) {
    return remote
  }
  return (await findRemoteNameForUrl(worktreePath, remote, options)) ?? remote
}

async function getConfiguredPushRemote(
  worktreePath: string,
  branch: string,
  options: GitRuntimeOptions = {}
): Promise<ConfiguredPushRemote | null> {
  const branchRemote = await getConfigValue(worktreePath, `branch.${branch}.remote`, options)
  const remote =
    (await getConfigValue(worktreePath, `branch.${branch}.pushRemote`, options)) ??
    (await getConfigValue(worktreePath, 'remote.pushDefault', options)) ??
    branchRemote
  if (!remote) {
    return null
  }
  return {
    remote: await normalizePushRemote(worktreePath, remote, options),
    branchRemote: branchRemote
      ? await normalizePushRemote(worktreePath, branchRemote, options)
      : null
  }
}

async function branchMergeTargetsConfiguredBase(
  worktreePath: string,
  branch: string,
  remote: string,
  branchRef: string,
  options: GitRuntimeOptions = {}
): Promise<boolean> {
  return gitRefTargetsBranchOnRemote(
    await getConfigValue(worktreePath, `branch.${branch}.base`, options),
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
  options: { forceWithLease?: boolean } & GitRuntimeOptions = {}
): Promise<void> {
  try {
    if (pushTarget) {
      await validateGitPushTarget(worktreePath, pushTarget, options)
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
      : await getConfiguredPushTarget(worktreePath, options)
    const args = [
      'push',
      ...(options.forceWithLease ? ['--force-with-lease'] : []),
      '--set-upstream',
      ...(target ? [target.remote, target.refspec] : ['origin', 'HEAD'])
    ]
    await gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}

async function gitPullWithArgs(
  worktreePath: string,
  pullArgs: string[],
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  try {
    if (pushTarget) {
      const target = await validateGitPushTarget(worktreePath, pushTarget, options)
      await gitExecFileAsync(
        ['pull', ...pullArgs, target.remoteName, target.branchName],
        gitOptionsForWorktree(worktreePath, options)
      )
      return
    }
    const upstream = await resolveEffectiveGitUpstream((args) =>
      gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
    )
    if (upstream && !upstream.isConfiguredUpstream) {
      // Why: legacy Orca branches may still track origin/main while pushes
      // target origin/<branch>. Pull the same effective branch the UI reports.
      await gitExecFileAsync(
        ['pull', ...pullArgs, upstream.remoteName, upstream.branchName],
        gitOptionsForWorktree(worktreePath, options)
      )
      return
    }

    await gitExecFileAsync(['pull', ...pullArgs], gitOptionsForWorktree(worktreePath, options))
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'pull'))
  }
}

export async function gitPull(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  // Why: plain `git pull` uses the user's configured pull strategy (merge by
  // default) so diverged branches reconcile instead of erroring out. Conflicts
  // surface through the existing conflict-resolution flow.
  await gitPullWithArgs(worktreePath, [], pushTarget, options)
}

export async function gitFastForward(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await gitPullWithArgs(worktreePath, ['--ff-only'], pushTarget, options)
}

export async function gitPullRebaseFromBase(
  worktreePath: string,
  baseRef: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  try {
    const source = await resolveGitRemoteRebaseSource(
      (args) => gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options)),
      baseRef
    )
    await gitExecFileAsync(
      ['pull', '--rebase', source.remoteName, source.branchName],
      gitOptionsForWorktree(worktreePath, options)
    )
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'pull'))
  }
}

export async function gitFetch(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  try {
    if (pushTarget) {
      const target = await validateGitPushTarget(worktreePath, pushTarget, options)
      await gitExecFileAsync(
        ['fetch', '--prune', target.remoteName],
        gitOptionsForWorktree(worktreePath, options)
      )
      return
    }
    await gitExecFileAsync(['fetch', '--prune'], gitOptionsForWorktree(worktreePath, options))
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'fetch'))
  }
}
