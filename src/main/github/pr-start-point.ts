import type { GitHubPrStartPoint, GitPushTarget } from '../../shared/types'
import { isMissingRemoteRefGitError } from '../git/fetch-error-classification'
import { getPullRequestPushTarget, getWorkItem } from './client'

type GitExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

type ResolveGitHubPrStartPointArgs = {
  repoPath: string
  prNumber: number
  headRefName?: string
  isCrossRepository?: boolean
  connectionId?: string | null
  gitExec: GitExec
  resolveRemote: () => Promise<string>
}

type ResolveGitHubPrStartPointResult = GitHubPrStartPoint | { error: string }

export async function resolveGitHubPrStartPoint(
  args: ResolveGitHubPrStartPointArgs
): Promise<ResolveGitHubPrStartPointResult> {
  let headRefName = args.headRefName?.trim() ?? ''
  let isCrossRepository = args.isCrossRepository === true
  let pushTarget: GitPushTarget | undefined
  let maintainerCanModify: boolean | undefined

  const resolvePushTarget = async (): Promise<void> => {
    if (pushTarget) {
      return
    }
    try {
      const resolved = await getPullRequestPushTarget(
        args.repoPath,
        args.prNumber,
        args.connectionId ?? null
      )
      pushTarget = resolved?.pushTarget
      maintainerCanModify = resolved?.maintainerCanModify
    } catch {
      // Why: deleted/inaccessible fork metadata can prevent push-target
      // discovery, but GitHub still exposes the PR head ref for checkout.
      pushTarget = undefined
    }
  }

  if (!headRefName) {
    const item = await getWorkItem(args.repoPath, args.prNumber, 'pr', args.connectionId ?? null)
    if (!item || item.type !== 'pr') {
      return { error: `PR #${args.prNumber} not found.` }
    }
    headRefName = (item.branchName ?? '').trim()
    if (!headRefName) {
      return { error: `PR #${args.prNumber} has no head branch.` }
    }
    if (item.isCrossRepository === true) {
      isCrossRepository = true
    }
  }

  if (isCrossRepository) {
    await resolvePushTarget()
  }

  let remote: string
  try {
    remote = await args.resolveRemote()
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
  }

  const fetchPullRequestHeadSha = async (): Promise<{ baseBranch: string } | { error: string }> => {
    const pullRef = `refs/pull/${args.prNumber}/head`
    try {
      await args.gitExec(['fetch', remote, pullRef])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        error: `Failed to fetch ${pullRef}: ${message.split('\n')[0]}`
      }
    }
    let sha: string
    try {
      const { stdout } = await args.gitExec(['rev-parse', '--verify', 'FETCH_HEAD'])
      sha = stdout.trim()
    } catch {
      return { error: `Could not resolve fork PR #${args.prNumber} head after fetch.` }
    }
    if (!sha) {
      return { error: `Empty SHA resolving fork PR #${args.prNumber} head.` }
    }
    return { baseBranch: sha }
  }

  // Why: fork PR heads live on a remote we don't have configured, so
  // `git fetch <remote> <headRefName>` would fail. GitHub exposes every
  // PR head (fork or same-repo) as refs/pull/<N>/head on the upstream repo.
  if (isCrossRepository) {
    const result = await fetchPullRequestHeadSha()
    if ('error' in result) {
      return result
    }
    // Why: adopt the contributor's branch name locally (mirroring the same-repo
    // return below) so fork-PR worktrees aren't renamed with the maintainer's
    // branch prefix (e.g. `me/866`). The push refspec still targets the fork.
    return {
      ...result,
      headSha: result.baseBranch,
      branchNameOverride: headRefName,
      ...(pushTarget ? { pushTarget } : {}),
      ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
    }
  }

  try {
    await args.gitExec([
      'fetch',
      remote,
      `+refs/heads/${headRefName}:refs/remotes/${remote}/${headRefName}`
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Why: missing fork metadata can make a fork PR look like a same-repo
    // branch. Only that missing-ref case should fall back to refs/pull.
    if (isMissingRemoteRefGitError(error)) {
      const result = await fetchPullRequestHeadSha()
      if (!('error' in result)) {
        await resolvePushTarget()
        return {
          ...result,
          headSha: result.baseBranch,
          branchNameOverride: headRefName,
          ...(pushTarget ? { pushTarget } : {}),
          ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
        }
      }
    }
    return {
      error: `Failed to fetch ${remote}/${headRefName}: ${message.split('\n')[0]}`
    }
  }

  const remoteRef = `${remote}/${headRefName}`
  let headSha: string
  try {
    const { stdout } = await args.gitExec(['rev-parse', '--verify', remoteRef])
    headSha = stdout.trim()
  } catch {
    return { error: `Remote ref ${remoteRef} does not exist after fetch.` }
  }
  if (!headSha) {
    return { error: `Empty SHA resolving PR #${args.prNumber} head.` }
  }

  return {
    baseBranch: headSha,
    headSha,
    branchNameOverride: headRefName,
    pushTarget: { remoteName: remote, branchName: headRefName }
  }
}
