import type { IssueSourcePreference } from '../../../../shared/repo-types'
import { isDefaultGitHubHost } from '../../../../shared/github/repository-identity-key'
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

const ISSUE_VIEW_BASE_JSON_FIELDS = 'number,title,state,url,labels,updatedAt,author'

function isUnknownJsonFieldError(message: string): boolean {
  return /unknown json field/i.test(message)
}

/** Why: blockedBy is github.com-only and mid-2026+ gh; ambient GH_HOST on the no-repo path may be GHES. */
function shouldRequestIssueBlockedByField(ownerRepo: GitHubApiRepository | null): boolean {
  return ownerRepo !== null && isDefaultGitHubHost(ownerRepo.host)
}

async function fetchIssueBlockedByNodes(args: {
  number: number
  ownerRepo: GitHubApiRepository
  ghOptions: GhExecOptions
}): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'issue',
        'view',
        String(args.number),
        '--repo',
        `${args.ownerRepo.owner}/${args.ownerRepo.repo}`,
        '--json',
        'blockedBy'
      ],
      args.ghOptions
    )
    return JSON.parse(stdout) as Record<string, unknown>
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Why: older gh rejects blockedBy; degrade to REST counts instead of failing the issue fetch.
    if (isUnknownJsonFieldError(message)) {
      return {}
    }
    throw err
  }
}

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
    const mapped = mapIssueWorkItem(item)
    // Why: REST only exposes issue_dependencies_summary counts; gh blockedBy nodes carry titles for the detail pill.
    if (
      shouldRequestIssueBlockedByField(ownerRepo) &&
      (mapped.blockedByCount ?? 0) > 0 &&
      !mapped.blockedBy?.length
    ) {
      try {
        const blockedMapped = mapIssueWorkItem({
          ...item,
          ...(await fetchIssueBlockedByNodes({ number, ownerRepo, ghOptions }))
        })
        return {
          ...mapped,
          ...(blockedMapped.blockedByCount !== undefined
            ? { blockedByCount: blockedMapped.blockedByCount }
            : {}),
          ...(blockedMapped.blockedBy !== undefined ? { blockedBy: blockedMapped.blockedBy } : {})
        }
      } catch {
        return mapped
      }
    }
    return mapped
  }

  if (connectionId) {
    // Why: SSH-backed gh has no repository cwd. A bare lookup could honor the
    // local process GH_REPO/GH_HOST and return an unrelated repository item.
    return null
  }

  // Why: unresolved host can target GHES via ambient GH_HOST; omit blockedBy (github.com-only).
  const { stdout } = await ghExecFileAsync(
    ['issue', 'view', String(number), '--json', ISSUE_VIEW_BASE_JSON_FIELDS],
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
