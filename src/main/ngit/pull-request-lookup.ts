import type { HostedReviewInfo } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import { getPrimaryNostrRepoRef, type NostrRepoRef } from './repository-ref'
import { getNostrRepositorySnapshot } from './repository-snapshot'
import type { ProjectedWorkItem } from './work-item-projection'

type LocalGitExecOptions = { wslDistro?: string }

const DEFAULT_BRANCH_NAMES = new Set(['main', 'master'])

export async function getNgitRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  branch?: string
): Promise<NostrRepoRef | null> {
  return getPrimaryNostrRepoRef(repoPath, connectionId, localGitOptions, branch)
}

/**
 * The id suffix of `pr/name(1a2b3c4d)` (ngit's checkout) or `name-1a2b3c4d` (a workspace Orca
 * started from the pull request, whatever branch prefix it got).
 */
const BRANCH_ID_SUFFIX = /(?:\(([0-9a-f]{8})\)|-([0-9a-f]{8}))$/

/** The pull request a local branch stands for, by link, ngit's branch naming, or tip commit. */
export function findPullRequestForBranch(
  items: readonly ProjectedWorkItem[],
  branch: string,
  { linkedNumber, headOid }: { linkedNumber?: number | null; headOid?: string | null } = {}
): ProjectedWorkItem | null {
  const pulls = items.filter(({ item }) => item.type === 'pr')
  if (linkedNumber != null) {
    return pulls.find(({ item }) => item.number === linkedNumber) ?? null
  }
  const shortBranch = branch.replace(/^refs\/heads\//, '')
  if (!shortBranch || DEFAULT_BRANCH_NAMES.has(shortBranch)) {
    return null
  }
  const suffix = shortBranch.match(BRANCH_ID_SUFFIX)
  const idPrefix = suffix?.[1] ?? suffix?.[2]
  const byId = idPrefix ? pulls.find(({ item }) => item.eventId.startsWith(idPrefix)) : undefined
  if (byId) {
    return byId
  }
  const name = shortBranch.replace(/^pr\//, '')
  const atHead = (candidate: ProjectedWorkItem): boolean =>
    Boolean(headOid) && candidate.item.headSha === headOid
  const named = pulls.filter(({ item }) => item.branchName?.replace(/^pr\//, '') === name)
  // A finished PR only claims a reused branch name while the checkout is still at its tip.
  return (
    named.find(({ item }) => item.state === 'open' || item.state === 'draft') ??
    named.find(atHead) ??
    pulls.find(atHead) ??
    null
  )
}

export function mapNgitPullRequestToReview({ item }: ProjectedWorkItem): HostedReviewInfo {
  return {
    provider: 'ngit',
    number: item.number,
    title: item.title,
    state: item.state,
    url: item.url,
    // NIP-34 has no check runs or mergeability.
    status: 'neutral',
    updatedAt: item.updatedAt,
    mergeable: 'UNKNOWN',
    ...(item.headSha ? { headSha: item.headSha } : {}),
    ...(item.baseRefName ? { baseRefName: item.baseRefName } : {})
  }
}

async function readPrimaryItems(
  repoPath: string,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions,
  force: boolean,
  branch: string
): Promise<ProjectedWorkItem[] | null> {
  const ref = await getPrimaryNostrRepoRef(repoPath, connectionId, localGitOptions, branch)
  if (!ref) {
    return null
  }
  const snapshot = await getNostrRepositorySnapshot(ref, { force })
  return snapshot?.items ?? null
}

/** Throws when no relay answers, so callers keep the last known review. */
export async function getNgitPullRequestForBranchOrThrow(
  repoPath: string,
  branch: string,
  linkedNumber: number | null,
  connectionId?: string | null,
  options: {
    localGitExecOptions?: LocalGitExecOptions
    currentHeadOid?: string | null
    userRefresh?: boolean
  } = {}
): Promise<ProjectedWorkItem | null> {
  const items = await readPrimaryItems(
    repoPath,
    connectionId,
    options.localGitExecOptions ?? {},
    options.userRefresh === true,
    branch
  )
  return items
    ? findPullRequestForBranch(items, branch, {
        linkedNumber,
        headOid: options.currentHeadOid
      })
    : null
}
