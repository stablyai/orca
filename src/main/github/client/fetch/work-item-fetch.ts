import type { IssueSourcePreference } from '../../../../shared/repo-types'
import {
  ghExecFileAsync,
  classifyGhError,
  ghRepoExecOptions,
  githubRepoContext,
  type LocalGitExecOptions
} from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import type { GhExecOptions } from './../github-exec-scope'
import { resolvePullRequestLookupCandidates } from './../pull-request-lookup-candidates'
import { detectRepositoryMergeMetadata } from './../detect/repository-merge-metadata'
import {
  WORK_ITEM_PR_DETAIL_JSON_FIELDS,
  usersFromUnknown,
  latestReviewsFromUnknown,
  type MainWorkItem
} from './../map/work-item-field-coercion'
import { mapIssueWorkItem, mapPullRequestWorkItem } from './../map/work-item'
export async function fetchIssueWorkItem(
  repoPath: string,
  ownerRepo: GitHubApiRepository | null,
  number: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<MainWorkItem | null> {
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(ownerRepo)
  }
  if (ownerRepo) {
    const { stdout } = await ghExecFileAsync(
      ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${number}`],
      ghOptions
    )
    const item = JSON.parse(stdout) as Record<string, unknown>
    if ('pull_request' in item) {
      return null
    }
    return mapIssueWorkItem(item)
  }

  if (connectionId) {
    // Why: SSH-backed gh has no repository cwd. A bare lookup could honor the
    // local process GH_REPO/GH_HOST and return an unrelated repository item.
    return null
  }

  const { stdout } = await ghExecFileAsync(
    ['issue', 'view', String(number), '--json', 'number,title,state,url,labels,updatedAt,author'],
    ghOptions
  )
  return mapIssueWorkItem(JSON.parse(stdout) as Record<string, unknown>)
}

// Why: REST /pulls/{n} lacks latestReviews, so pull review fields from gh so reviewer lists aren't silently empty.
export const WORK_ITEM_PR_REVIEW_JSON_FIELDS = 'reviewRequests,latestReviews'

export async function fetchPullRequestReviewFields(
  number: number,
  ownerRepo: GitHubApiRepository | null,
  ghOptions: GhExecOptions
): Promise<Pick<MainWorkItem, 'reviewRequests' | 'latestReviews'>> {
  try {
    const args = ownerRepo
      ? [
          'pr',
          'view',
          String(number),
          '--repo',
          `${ownerRepo.owner}/${ownerRepo.repo}`,
          '--json',
          WORK_ITEM_PR_REVIEW_JSON_FIELDS
        ]
      : ['pr', 'view', String(number), '--json', WORK_ITEM_PR_REVIEW_JSON_FIELDS]
    const { stdout } = await ghExecFileAsync(args, ghOptions)
    const item = JSON.parse(stdout) as Record<string, unknown>
    return {
      ...(item.reviewRequests !== undefined
        ? { reviewRequests: usersFromUnknown(item.reviewRequests) }
        : {}),
      ...(item.latestReviews !== undefined
        ? { latestReviews: latestReviewsFromUnknown(item.latestReviews) }
        : {})
    }
  } catch {
    return {}
  }
}

export async function fetchPullRequestWorkItem(
  repoPath: string,
  ownerRepo: GitHubApiRepository | null,
  number: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<MainWorkItem | null> {
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(ownerRepo)
  }
  if (ownerRepo) {
    try {
      const { stdout } = await ghExecFileAsync(
        [
          'pr',
          'view',
          String(number),
          '--repo',
          `${ownerRepo.owner}/${ownerRepo.repo}`,
          '--json',
          WORK_ITEM_PR_DETAIL_JSON_FIELDS
        ],
        ghOptions
      )
      const item = JSON.parse(stdout) as Record<string, unknown>
      const mapped = mapPullRequestWorkItem(item, ownerRepo)
      // Why: merge-metadata GraphQL is best-effort — don't fall through to REST, which drops latestReviews and blanks bot-only reviewer lists.
      const baseRefName = typeof item.baseRefName === 'string' ? item.baseRefName : undefined
      try {
        const mergeMetadata = await detectRepositoryMergeMetadata(ownerRepo, baseRefName, ghOptions)
        return {
          ...mapped,
          mergeQueueRequired: mergeMetadata.mergeQueueRequired,
          ...(mergeMetadata.autoMergeAllowed !== null
            ? { autoMergeAllowed: mergeMetadata.autoMergeAllowed }
            : {}),
          ...(mergeMetadata.mergeMethodSettings
            ? { mergeMethodSettings: mergeMetadata.mergeMethodSettings }
            : {})
        }
      } catch {
        return mapped
      }
    } catch {
      const { stdout } = await ghExecFileAsync(
        ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${number}`],
        ghOptions
      )
      const mapped = mapPullRequestWorkItem(
        JSON.parse(stdout) as Record<string, unknown>,
        ownerRepo
      )
      const reviewFields = await fetchPullRequestReviewFields(number, ownerRepo, ghOptions)
      return { ...mapped, ...reviewFields }
    }
  }

  if (connectionId) {
    // Why: connection-backed gh cannot infer a repository from cwd. Refuse a
    // bare call so process-level GH_REPO/GH_HOST cannot redirect the lookup.
    return null
  }

  const { stdout } = await ghExecFileAsync(
    ['pr', 'view', String(number), '--json', WORK_ITEM_PR_DETAIL_JSON_FIELDS],
    ghOptions
  )
  return mapPullRequestWorkItem(JSON.parse(stdout) as Record<string, unknown>)
}

export async function fetchPullRequestWorkItemFromCandidates(
  repoPath: string,
  number: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  preference?: IssueSourcePreference
): Promise<MainWorkItem | null> {
  const candidates = await resolvePullRequestLookupCandidates(
    repoPath,
    preference,
    connectionId,
    localGitOptions
  )
  if (candidates.length === 0) {
    if (preference === 'origin') {
      return null
    }
    return fetchPullRequestWorkItem(repoPath, null, number, connectionId, localGitOptions)
  }
  for (const candidate of candidates) {
    try {
      return await fetchPullRequestWorkItem(
        repoPath,
        candidate,
        number,
        connectionId,
        localGitOptions
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const classification = classifyGhError(message).type
      if (classification !== 'not_found' && classification !== 'permission_denied') {
        throw err
      }
    }
  }
  return null
}
