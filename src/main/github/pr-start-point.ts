import type { GitHubPrStartPoint, GitPushTarget } from '../../shared/types'
import { isMissingRemoteRefGitError } from '../git/fetch-error-classification'
import { getPullRequestPushTarget, getWorkItem } from './client'

type GitExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

type ResolveGitHubPrStartPointArgs = {
  repoPath: string
  prNumber: number
  headRefName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  connectionId?: string | null
  localGitOptions?: { wslDistro?: string }
  gitExec: GitExec
  fetchRemoteTrackingRef: (remote: string, branch: string) => Promise<void>
  resolveRemote: () => Promise<string>
  // Why: when the primary remote (e.g. an upstream fork alias) lacks the
  // branch, walking additional remotes is the only way to recover. Callers
  // are expected to exclude `resolveRemote()`'s value from this list.
  resolveRemoteAlternatives: () => Promise<string[]>
}

type ResolveGitHubPrStartPointResult = GitHubPrStartPoint | { error: string }

function localGitOptionArgs(
  options: { wslDistro?: string } | undefined
): [] | [{ wslDistro?: string }] {
  return options && Object.keys(options).length > 0 ? [options] : []
}

export async function resolveGitHubPrStartPoint(
  args: ResolveGitHubPrStartPointArgs
): Promise<ResolveGitHubPrStartPointResult> {
  let headRefName = args.headRefName?.trim() ?? ''
  let baseRefName = args.baseRefName?.trim() ?? ''
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
        args.connectionId ?? null,
        ...localGitOptionArgs(args.localGitOptions)
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
    const item = await getWorkItem(
      args.repoPath,
      args.prNumber,
      'pr',
      args.connectionId ?? null,
      ...localGitOptionArgs(args.localGitOptions)
    )
    if (!item || item.type !== 'pr') {
      return { error: `PR #${args.prNumber} not found.` }
    }
    headRefName = (item.branchName ?? '').trim()
    baseRefName = (item.baseRefName ?? '').trim()
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

  let primary: string
  try {
    primary = await args.resolveRemote()
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
  }
  let alternatives: string[]
  try {
    alternatives = await args.resolveRemoteAlternatives()
  } catch {
    // Why: enumeration failures shouldn't block the primary path; fall back to
    // single-remote behavior so existing happy-path flows keep working.
    alternatives = []
  }
  // Why: ordering matters — the primary is tried first to keep existing
  // single-remote behavior identical. A Set dedupes callers that hand back
  // the primary again, preserving insertion order.
  const remoteCandidates = Array.from(new Set([primary, ...alternatives]))

  // Why: only "missing ref" is a candidate to walk remotes. Network, auth, or
  // SSH failures on the primary remote must surface immediately so users get
  // the real error rather than a confusing fall-through to refs/pull.
  const fetchBranchFromAnyRemote = async (
    branch: string
  ): Promise<{ remote: string } | { error: string } | null> => {
    for (const remote of remoteCandidates) {
      try {
        await args.fetchRemoteTrackingRef(remote, branch)
        return { remote }
      } catch (error) {
        if (isMissingRemoteRefGitError(error)) {
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          error: `Failed to fetch ${remote}/${branch}: ${message.split('\n')[0]}`
        }
      }
    }
    return null
  }

  const fetchPullRequestHeadShaFromAnyRemote = async (): Promise<
    { remote: string; sha: string } | { error: string }
  > => {
    const pullRef = `refs/pull/${args.prNumber}/head`
    let workingRemote: string | null = null
    for (const candidate of remoteCandidates) {
      try {
        await args.gitExec(['fetch', candidate, pullRef])
        workingRemote = candidate
        break
      } catch (error) {
        if (isMissingRemoteRefGitError(error)) {
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          error: `Failed to fetch ${pullRef}: ${message.split('\n')[0]}`
        }
      }
    }
    if (workingRemote === null) {
      return {
        error: `Failed to fetch ${pullRef} from any configured remote (${remoteCandidates.join(', ')}).`
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
    return { remote: workingRemote, sha }
  }

  const fetchCompareBaseRef = async (
    preferredRemote: string
  ): Promise<{ error: string } | null> => {
    if (!baseRefName) {
      return null
    }
    // Why: the base branch usually lives on the same remote as the head; prefer
    // it first so the original compareBaseRef shape is preserved when the head
    // remote is healthy. Walk the rest only on missing-ref.
    const orderedRemotes = Array.from(
      new Set([preferredRemote, ...remoteCandidates.filter((r) => r !== preferredRemote)])
    )
    for (const remote of orderedRemotes) {
      try {
        await args.fetchRemoteTrackingRef(remote, baseRefName)
        return null
      } catch (error) {
        if (isMissingRemoteRefGitError(error)) {
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          error: `Failed to fetch ${remote}/${baseRefName}: ${message.split('\n')[0]}`
        }
      }
    }
    return {
      error: `Failed to fetch ${baseRefName} from any configured remote (${remoteCandidates.join(', ')}).`
    }
  }

  // Why: fork PR heads live on a remote we don't have configured, so
  // `git fetch <remote> <headRefName>` would fail. GitHub exposes every
  // PR head (fork or same-repo) as refs/pull/<N>/head on the upstream repo.
  if (isCrossRepository) {
    const headResult = await fetchPullRequestHeadShaFromAnyRemote()
    if ('error' in headResult) {
      return headResult
    }
    const compareBaseFetchError = await fetchCompareBaseRef(headResult.remote)
    if (compareBaseFetchError) {
      return compareBaseFetchError
    }
    // Why: adopt the contributor's branch name locally (mirroring the same-repo
    // return below) so fork-PR worktrees aren't renamed with the maintainer's
    // branch prefix (e.g. `me/866`). The push refspec still targets the fork.
    return {
      baseBranch: headResult.sha,
      ...(baseRefName
        ? { compareBaseRef: `refs/remotes/${headResult.remote}/${baseRefName}` }
        : {}),
      headSha: headResult.sha,
      branchNameOverride: headRefName,
      ...(pushTarget ? { pushTarget } : {}),
      ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
    }
  }

  const headRemoteResult = await fetchBranchFromAnyRemote(headRefName)
  if (headRemoteResult === null) {
    // Why: missing fork metadata can make a fork PR look like a same-repo
    // branch. Only that missing-ref case should fall back to refs/pull.
    const headResult = await fetchPullRequestHeadShaFromAnyRemote()
    if (!('error' in headResult)) {
      await resolvePushTarget()
      const compareBaseFetchError = await fetchCompareBaseRef(headResult.remote)
      if (compareBaseFetchError) {
        return compareBaseFetchError
      }
      return {
        baseBranch: headResult.sha,
        ...(baseRefName
          ? { compareBaseRef: `refs/remotes/${headResult.remote}/${baseRefName}` }
          : {}),
        headSha: headResult.sha,
        branchNameOverride: headRefName,
        ...(pushTarget ? { pushTarget } : {}),
        ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
      }
    }
    return {
      error: `Failed to fetch ${headRefName} (or refs/pull/${args.prNumber}/head) from any configured remote (${remoteCandidates.join(', ')}).`
    }
  }
  if ('error' in headRemoteResult) {
    return headRemoteResult
  }

  const headRemote = headRemoteResult.remote
  const remoteRef = `${headRemote}/${headRefName}`
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
  const compareBaseFetchError = await fetchCompareBaseRef(headRemote)
  if (compareBaseFetchError) {
    return compareBaseFetchError
  }

  return {
    baseBranch: headSha,
    ...(baseRefName ? { compareBaseRef: `refs/remotes/${headRemote}/${baseRefName}` } : {}),
    headSha,
    branchNameOverride: headRefName,
    pushTarget: { remoteName: headRemote, branchName: headRefName }
  }
}
