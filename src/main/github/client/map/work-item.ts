import type { OwnerRepo } from '../../gh-utils'
import {
  authorFieldsFromUnknown,
  extractHeadOwnerLogin,
  usersFromUnknown,
  reviewRequestsFromUnknown,
  latestReviewsFromUnknown,
  numberFromUnknown,
  normalizePRMergeable,
  normalizeReviewDecision,
  isAutoMergeEnabled,
  deriveWorkItemCheckSummary,
  type MainWorkItem
} from './work-item-field-coercion'
export function mapIssueWorkItem(item: Record<string, unknown>): MainWorkItem {
  return {
    id: `issue:${String(item.number)}`,
    type: 'issue',
    number: Number(item.number),
    title: String(item.title ?? ''),
    state: String(item.state ?? 'open') === 'closed' ? 'closed' : 'open',
    url: String(item.html_url ?? item.url ?? ''),
    labels: Array.isArray(item.labels)
      ? item.labels
          .map((label) =>
            typeof label === 'object' && label !== null && 'name' in label
              ? String((label as { name?: unknown }).name ?? '')
              : ''
          )
          .filter(Boolean)
      : [],
    updatedAt: String(item.updated_at ?? item.updatedAt ?? ''),
    ...authorFieldsFromUnknown(item),
    ...(typeof item.comments === 'number' ? { commentCount: item.comments } : {}),
    ...(item.assignees !== undefined ? { assignees: usersFromUnknown(item.assignees) } : {})
  }
}

export function mapPullRequestWorkItem(
  item: Record<string, unknown>,
  baseOwnerRepo: OwnerRepo | null = null
): MainWorkItem {
  const headOwnerLogin = extractHeadOwnerLogin(item)
  // Unknown head ownership must not be presented as proven same-repository.
  const isCrossRepository =
    headOwnerLogin !== null && baseOwnerRepo !== null
      ? headOwnerLogin !== baseOwnerRepo.owner
      : null
  const state = String(item.state ?? '').toLowerCase()
  const additions = numberFromUnknown(item.additions)
  const deletions = numberFromUnknown(item.deletions)
  const changedFiles = numberFromUnknown(
    item.changedFiles ??
      item.changed_files ??
      (item.files as { totalCount?: unknown } | undefined)?.totalCount
  )
  const mergeable = normalizePRMergeable(item.mergeable)
  const headSha =
    typeof item.headRefOid === 'string'
      ? item.headRefOid
      : typeof item.head === 'object' && item.head !== null
        ? typeof (item.head as { sha?: unknown }).sha === 'string'
          ? (item.head as { sha: string }).sha
          : undefined
        : undefined
  return {
    id: `pr:${String(item.number)}`,
    type: 'pr',
    number: Number(item.number),
    title: String(item.title ?? ''),
    state:
      state === 'merged' || item.merged_at || item.mergedAt
        ? 'merged'
        : state === 'closed'
          ? 'closed'
          : item.isDraft || item.draft
            ? 'draft'
            : 'open',
    url: String(item.html_url ?? item.url ?? ''),
    labels: Array.isArray(item.labels)
      ? item.labels
          .map((label) =>
            typeof label === 'object' && label !== null && 'name' in label
              ? String((label as { name?: unknown }).name ?? '')
              : ''
          )
          .filter(Boolean)
      : [],
    updatedAt: String(item.updated_at ?? item.updatedAt ?? ''),
    ...authorFieldsFromUnknown(item),
    branchName:
      typeof item.head === 'object' && item.head !== null && 'ref' in item.head
        ? String((item.head as { ref?: unknown }).ref ?? '')
        : String(item.headRefName ?? ''),
    baseRefName:
      typeof item.base === 'object' && item.base !== null && 'ref' in item.base
        ? String((item.base as { ref?: unknown }).ref ?? '')
        : String(item.baseRefName ?? ''),
    ...(headSha ? { headSha } : {}),
    ...(baseOwnerRepo
      ? {
          prRepo: {
            owner: baseOwnerRepo.owner,
            repo: baseOwnerRepo.repo,
            ...(baseOwnerRepo.host ? { host: baseOwnerRepo.host } : {})
          }
        }
      : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(changedFiles !== undefined ? { changedFiles } : {}),
    ...('reviewDecision' in item
      ? { reviewDecision: normalizeReviewDecision(item.reviewDecision) }
      : {}),
    ...(item.reviewRequests !== undefined || item.requested_reviewers !== undefined
      ? {
          reviewRequests:
            item.reviewRequests !== undefined
              ? reviewRequestsFromUnknown(item.reviewRequests, baseOwnerRepo?.owner ?? null)
              : [
                  ...usersFromUnknown(item.requested_reviewers),
                  ...reviewRequestsFromUnknown(item.requested_teams, baseOwnerRepo?.owner ?? null)
                ]
        }
      : {}),
    ...(item.latestReviews !== undefined
      ? { latestReviews: latestReviewsFromUnknown(item.latestReviews) }
      : {}),
    ...(item.assignees !== undefined ? { assignees: usersFromUnknown(item.assignees) } : {}),
    ...(item.statusCheckRollup !== undefined
      ? { checksSummary: deriveWorkItemCheckSummary(item.statusCheckRollup) }
      : {}),
    ...(mergeable ? { mergeable } : {}),
    ...('autoMergeRequest' in item || 'auto_merge' in item
      ? { autoMergeEnabled: isAutoMergeEnabled(item.autoMergeRequest ?? item.auto_merge) }
      : {}),
    ...('mergeStateStatus' in item || 'mergeable_state' in item
      ? {
          mergeStateStatus:
            typeof item.mergeStateStatus === 'string'
              ? item.mergeStateStatus
              : typeof item.mergeable_state === 'string'
                ? item.mergeable_state.toUpperCase()
                : null
        }
      : {}),
    ...(typeof item.maintainerCanModify === 'boolean'
      ? { maintainerCanModify: item.maintainerCanModify }
      : {}),
    ...(isCrossRepository !== null ? { isCrossRepository } : {})
  }
}
