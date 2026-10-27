import type { ClassifiedError } from '../../../../shared/classified-error'
import type { IssueSourcePreference } from '../../../../shared/repo-types'
import type { ParsedTaskQuery } from '../../../../shared/task-query'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/work-items'
import { shouldProbeGitRemote } from '../../../git/remote-name-listing'
import type { LocalGitExecOptions, OwnerRepo } from '../../gh-utils'
import {
  getGitHubApiRepositoryForRemote,
  getOriginGitHubApiRepository
} from '../../github-api-repository'
import { WORK_ITEM_PR_LIST_JSON_FIELDS, type MainWorkItem } from './../map/work-item-field-coercion'
import { WORK_ITEM_NUMBER_SORT_QUALIFIER, quoteGitHubSearchValue } from './work-item-search-query'
export type WorkItemListRequest = {
  args: string[]
  offset: number
}

export function normalizeWorkItemPage(page: number | undefined): number {
  return typeof page === 'number' && Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
}

export function buildWorkItemListRequest(args: {
  kind: 'issue' | 'pr'
  ownerRepo: OwnerRepo
  limit: number
  query: ParsedTaskQuery
  page: number
}): WorkItemListRequest {
  const { kind, ownerRepo, limit, query, page } = args
  const searchParts: string[] = []

  if (kind === 'issue') {
    searchParts.push(`repo:${ownerRepo.owner}/${ownerRepo.repo}`)
  }
  searchParts.push(kind === 'issue' ? 'is:issue' : 'is:pr')

  if (query.state === 'open') {
    searchParts.push('is:open')
  } else if (query.state === 'closed') {
    searchParts.push('is:closed')
    if (kind === 'pr') {
      searchParts.push('-is:merged')
    }
  } else if (query.state === 'merged') {
    searchParts.push('is:merged')
  }

  if (kind === 'pr' && query.draft) {
    searchParts.push('draft:true')
  }

  if (query.assignee) {
    searchParts.push(`assignee:${quoteGitHubSearchValue(query.assignee)}`)
  }
  if (query.author) {
    searchParts.push(`author:${quoteGitHubSearchValue(query.author)}`)
  }
  if (query.labels.length > 0) {
    for (const label of query.labels) {
      searchParts.push(`label:${quoteGitHubSearchValue(label)}`)
    }
  }
  if (kind === 'pr' && query.reviewRequested) {
    searchParts.push(`review-requested:${quoteGitHubSearchValue(query.reviewRequested)}`)
  }
  if (kind === 'pr' && query.reviewedBy) {
    searchParts.push(`reviewed-by:${quoteGitHubSearchValue(query.reviewedBy)}`)
  }
  if (query.freeText) {
    searchParts.push(query.freeText)
  }

  if (kind === 'issue') {
    return {
      args: [
        'api',
        '--cache',
        '120s',
        `search/issues?q=${encodeURIComponent(searchParts.join(' '))}&sort=created&order=desc&per_page=${limit}&page=${page}`,
        '--jq',
        '.items'
      ],
      offset: 0
    }
  }

  // Rich PR fields require gh pr list; align its creation sort with numbered issue searches.
  searchParts.push(WORK_ITEM_NUMBER_SORT_QUALIFIER)
  const out = [
    'pr',
    'list',
    '--limit',
    String(Math.min(page * limit, 1000)),
    '--state',
    'all',
    '--json',
    WORK_ITEM_PR_LIST_JSON_FIELDS
  ]
  out.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
  out.push('--search', searchParts.join(' '))
  return { args: out, offset: (page - 1) * limit }
}

// Carry per-source failures through IPC so pagination cannot mistake them for end-of-data.
export type PartialWorkItemsResult = {
  items: MainWorkItem[]
  issuesError?: ClassifiedError
  prsError?: ClassifiedError
}

export function assertSshRepoHasResolvedGitHubSource(args: {
  connectionId?: string | null
  issueOwnerRepo: OwnerRepo | null
  prOwnerRepo: OwnerRepo | null
}): void {
  if (!args.connectionId || args.issueOwnerRepo || args.prOwnerRepo) {
    return
  }
  // SSH-only paths cannot let gh infer a local repository.
  throw new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
}

export type ResolvedPrWorkItemSource = {
  source: OwnerRepo | null
  originCandidate: OwnerRepo | null
  upstreamCandidate: OwnerRepo | null
}

/** Only explicit origin is origin-only; other preferences retain upstream-first candidate resolution. */
export async function resolvePrWorkItemSource(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedPrWorkItemSource> {
  const originCandidatePromise = getOriginGitHubApiRepository(
    repoPath,
    connectionId,
    localGitOptions
  )
  // Skip known-absent upstreams; unknown remote discovery remains fail-open.
  const upstreamCandidatePromise = shouldProbeGitRemote(
    repoPath,
    'upstream',
    connectionId,
    localGitOptions
  ).then((shouldProbe) =>
    shouldProbe
      ? getGitHubApiRepositoryForRemote(repoPath, 'upstream', connectionId, localGitOptions)
      : null
  )
  const [originCandidate, upstreamCandidate] = await Promise.all([
    originCandidatePromise,
    upstreamCandidatePromise
  ])
  // Fork contribution PRs live upstream; explicit origin alone selects the fork namespace.
  const source = preference === 'origin' ? originCandidate : (upstreamCandidate ?? originCandidate)
  return { source, originCandidate, upstreamCandidate }
}
