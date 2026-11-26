import type { HostedReviewInfo } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  isNgitDefaultBranch,
  ngitBranchIdPrefix,
  ngitProposalName,
  ngitShortBranch
} from '../../shared/ngit/ngit-branch-names'
import { getPrimaryNostrRepoRef, type NostrRepoRef } from './repository-ref'
import { getNostrRepositorySnapshot } from './repository-snapshot'
import type { ProjectedWorkItem } from './work-item-projection'

type LocalGitExecOptions = { wslDistro?: string }

export async function getNgitRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  branch?: string
): Promise<NostrRepoRef | null> {
  return getPrimaryNostrRepoRef(repoPath, connectionId, localGitOptions, branch)
}

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
  if (!ngitShortBranch(branch) || isNgitDefaultBranch(branch)) {
    return null
  }
  const idPrefix = ngitBranchIdPrefix(branch)
  const byId = idPrefix ? pulls.find(({ item }) => item.eventId.startsWith(idPrefix)) : undefined
  if (byId) {
    return byId
  }
  const name = ngitProposalName(branch)
  const atHead = (candidate: ProjectedWorkItem): boolean =>
    Boolean(headOid) && candidate.item.headSha === headOid
  const named = pulls.filter(
    ({ item }) => item.branchName !== undefined && ngitProposalName(item.branchName) === name
  )
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
