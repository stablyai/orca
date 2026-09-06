import type { HostTaskProjectItemTarget } from './host-task-project-mutation-operations'
import type { GitHubProjectRow } from './mobile-tasks-view-state-types'

// Why local, not imported from mobile-tasks-item-mapping: these two readers are pure row
// identity, while that module value-imports the Tasks barrel (and the RN theme through it).
function projectRowType(row: GitHubProjectRow): 'issue' | 'pr' | null {
  return row.itemType === 'ISSUE' ? 'issue' : row.itemType === 'PULL_REQUEST' ? 'pr' : null
}

function splitRepositorySlug(slug: string | null): { owner: string; repo: string } | null {
  const [owner, repo] = slug?.split('/') ?? []
  return owner && repo ? { owner, repo } : null
}

/** For mutations the host addresses by issue/PR number and kind: comment adds, item edits, merges. */
export function projectRowMutationTarget(
  row: GitHubProjectRow,
  host: string
): HostTaskProjectItemTarget | null {
  const slug = splitRepositorySlug(row.content.repository)
  const type = projectRowType(row)
  return slug && type && row.content.number
    ? { ...slug, host, number: row.content.number, type, targetId: row.targetId }
    : null
}

/**
 * For mutations the host addresses by repository slug and comment id — the `*BySlug` comment
 * edits. They read no issue number and no issue/PR kind, so requiring those refused rows
 * (draft project items, PR rows before their number lands) the host would have accepted.
 */
export function projectRowSlugTarget(
  row: GitHubProjectRow,
  host: string
): HostTaskProjectItemTarget | null {
  const slug = splitRepositorySlug(row.content.repository)
  return slug ? { ...slug, host, ...rowIdentityFallbacks(row), targetId: row.targetId } : null
}

/**
 * For mutations the host addresses by project item id or review thread id — `updateItemField`,
 * `clearItemField` and `resolveReviewThread`. None of them read the slug, the number or the
 * kind, so a DRAFT_ISSUE row must not be refused.
 */
export function projectRowIdentityTarget(
  row: GitHubProjectRow,
  host: string
): HostTaskProjectItemTarget {
  const slug = splitRepositorySlug(row.content.repository)
  return {
    owner: slug?.owner ?? '',
    repo: slug?.repo ?? '',
    host,
    ...rowIdentityFallbacks(row),
    targetId: row.targetId
  }
}

// Why: the target shape carries these for the number-addressed methods; the id-addressed ones
// never read them, so a placeholder cannot reach the host.
function rowIdentityFallbacks(row: GitHubProjectRow): { number: number; type: 'issue' | 'pr' } {
  return { number: row.content.number ?? 0, type: projectRowType(row) ?? 'issue' }
}
