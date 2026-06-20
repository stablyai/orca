import { assertGitPushTargetShape } from '../shared/git-push-target-validation'
import { gitRefTargetsBranchOnRemote } from '../shared/git-remote-branch-name'
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
    const [pushRemote, { stdout: mergeStdout }] = await Promise.all([
      getConfiguredPushRemote(git, worktreePath, branch),
      git(['config', '--get', `branch.${branch}.merge`], worktreePath)
    ])
    const remote = pushRemote?.remote
    const mergeRef = mergeStdout.trim()
    const branchRef = mergeRef.replace(/^refs\/heads\//, '')
    if (!remote || !branchRef || remote === '.' || branchRef === mergeRef) {
      return null
    }
    if (await branchMergeTargetsConfiguredBase(git, worktreePath, branch, remote, branchRef)) {
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
  git: RelayGit,
  worktreePath: string,
  key: string
): Promise<string | null> {
  try {
    const { stdout } = await git(['config', '--get', key], worktreePath)
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
  git: RelayGit,
  worktreePath: string,
  remoteUrl: string
): Promise<string | null> {
  try {
    const { stdout } = await git(['remote'], worktreePath)
    const remotes = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const remoteName of remotes) {
      try {
        const { stdout: urlStdout } = await git(['remote', 'get-url', remoteName], worktreePath)
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
  git: RelayGit,
  worktreePath: string,
  remote: string
): Promise<string> {
  if (!isUrlValuedRemote(remote)) {
    return remote
  }
  return (await findRemoteNameForUrl(git, worktreePath, remote)) ?? remote
}

async function getConfiguredPushRemote(
  git: RelayGit,
  worktreePath: string,
  branch: string
): Promise<ConfiguredPushRemote | null> {
  // Why: mirror the local gitPush resolver so SSH worktrees do not drift to a
  // different target when branch.pushRemote or remote.pushDefault is present.
  const branchRemote = await getConfigValue(git, worktreePath, `branch.${branch}.remote`)
  const remote =
    (await getConfigValue(git, worktreePath, `branch.${branch}.pushRemote`)) ??
    (await getConfigValue(git, worktreePath, 'remote.pushDefault')) ??
    branchRemote
  if (!remote) {
    return null
  }
  return {
    remote: await normalizePushRemote(git, worktreePath, remote),
    branchRemote: branchRemote ? await normalizePushRemote(git, worktreePath, branchRemote) : null
  }
}

async function branchMergeTargetsConfiguredBase(
  git: RelayGit,
  worktreePath: string,
  branch: string,
  remote: string,
  branchRef: string
): Promise<boolean> {
  return gitRefTargetsBranchOnRemote(
    await getConfigValue(git, worktreePath, `branch.${branch}.base`),
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
