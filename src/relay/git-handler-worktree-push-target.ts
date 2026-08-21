import { assertGitPushTargetShape } from '../shared/git-push-target-validation'
import { sameGitHubRemoteUrl } from '../shared/git-push-target-remote-url'
import type { GitPushTarget } from '../shared/worktree/types'
import type { GitExec } from './git-handler-ops'

const RESERVED_REMOTES = new Set(['origin', 'upstream'])

function requireRepoPath(params: Record<string, unknown>): string {
  if (typeof params.repoPath !== 'string' || !params.repoPath || params.repoPath.includes('\0')) {
    throw new Error('Invalid worktree push target repository path.')
  }
  return params.repoPath
}

function requireWorktreePath(params: Record<string, unknown>): string {
  if (
    typeof params.worktreePath !== 'string' ||
    !params.worktreePath ||
    params.worktreePath.includes('\0')
  ) {
    throw new Error('Invalid worktree push target path.')
  }
  return params.worktreePath
}

function requireTarget(params: Record<string, unknown>): GitPushTarget {
  assertGitPushTargetShape(params.target)
  return params.target
}

function requireMutableRemoteTarget(
  params: Record<string, unknown>
): GitPushTarget & { remoteUrl: string } {
  const target = requireTarget(params)
  if (!target.remoteUrl) {
    throw new Error('Worktree push target remote mutation requires a remote URL.')
  }
  if (RESERVED_REMOTES.has(target.remoteName)) {
    throw new Error(`Worktree push target cannot mutate reserved remote "${target.remoteName}".`)
  }
  return target as GitPushTarget & { remoteUrl: string }
}

export async function addWorktreePushTargetRemoteOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<void> {
  const repoPath = requireRepoPath(params)
  const target = requireMutableRemoteTarget(params)
  await git(['remote', 'add', target.remoteName, target.remoteUrl], repoPath)
}

export async function configureWorktreePushTargetOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<void> {
  const worktreePath = requireWorktreePath(params)
  const target = requireTarget(params)
  const branchName = params.branchName
  if (typeof branchName !== 'string' || !branchName || branchName.startsWith('-')) {
    throw new Error('Invalid worktree push target local branch name.')
  }
  await git(
    ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, branchName],
    worktreePath
  )
}

export async function removeWorktreePushTargetRemoteOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<void> {
  const repoPath = requireRepoPath(params)
  const target = requireMutableRemoteTarget(params)
  let configuredUrl: string
  try {
    configuredUrl = (await git(['remote', 'get-url', target.remoteName], repoPath)).stdout.trim()
  } catch {
    return
  }
  if (!sameGitHubRemoteUrl(configuredUrl, target.remoteUrl)) {
    return
  }
  await git(['remote', 'remove', target.remoteName], repoPath)
}
