import type { ListWorkItemsResult } from '../../../../shared/github/work-item-types'
import type { IssueSourcePreference } from '../../../../shared/repo-types'
import { isGitHubWorkItemsQueryTooLarge } from '../../../../shared/github/work-items-query-bounds'
import { parseTaskQuery } from '../../../../shared/task-query'
import { acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveIssueGitHubApiRepositorySource } from '../../github-api-repository'
import type { MainWorkItem } from './../map/work-item-field-coercion'
import { normalizeWorkItemPage, resolvePrWorkItemSource } from './work-item-list-request'
import { listRecentWorkItems, listQueriedWorkItems } from './work-item-pages'
export async function listWorkItems(
  repoPath: string,
  limit = 24,
  query?: string,
  page?: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  noCache?: boolean,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ListWorkItemsResult<MainWorkItem>> {
  const trimmedQuery = query?.trim() ?? ''
  const requestedPage = normalizeWorkItemPage(page)
  if (isGitHubWorkItemsQueryTooLarge(trimmedQuery)) {
    return {
      items: [],
      sources: {
        issues: null,
        prs: null,
        originCandidate: null,
        upstreamCandidate: null
      }
    }
  }
  const [issueResolved, prResolved] = await Promise.all([
    resolveIssueGitHubApiRepositorySource(repoPath, preference, connectionId, localGitOptions),
    resolvePrWorkItemSource(repoPath, preference, connectionId, localGitOptions)
  ])
  const issueOwnerRepo = issueResolved.source
  const prOwnerRepo = prResolved.source
  await acquire()
  try {
    // Why: let errors propagate to IPC — a catch-all would make failure indistinguishable from empty and under-report per-repo failures.
    const partial = !trimmedQuery
      ? await listRecentWorkItems(
          repoPath,
          issueOwnerRepo,
          prOwnerRepo,
          limit,
          requestedPage,
          connectionId,
          noCache,
          localGitOptions
        )
      : await listQueriedWorkItems(
          repoPath,
          issueOwnerRepo,
          prOwnerRepo,
          parseTaskQuery(trimmedQuery),
          limit,
          requestedPage,
          connectionId,
          localGitOptions
        )

    const errors =
      partial.issuesError || partial.prsError
        ? {
            ...(partial.issuesError ? { issues: partial.issuesError } : {}),
            ...(partial.prsError ? { prs: partial.prsError } : {})
          }
        : undefined
    return {
      items: partial.items,
      sources: {
        issues: issueOwnerRepo,
        prs: prOwnerRepo,
        originCandidate: prResolved.originCandidate,
        upstreamCandidate: prResolved.upstreamCandidate
      },
      ...(errors ? { errors } : {}),
      ...(issueResolved.fellBack ? { issueSourceFellBack: true } : {})
    }
  } finally {
    release()
  }
}
