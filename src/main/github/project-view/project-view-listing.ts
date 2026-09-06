import type { ListProjectViewsArgs } from '../../../shared/github/project-request-types'
import type { ListProjectViewsResult } from '../../../shared/github/project-result-types'
import type {
  GitHubProjectViewLayout,
  GitHubProjectViewSummary
} from '../../../shared/github/project-types'
import { assertPositiveInt, assertSlug } from './internals'
import { fetchProjectViewsPage } from './project-view-config'

// ─── listProjectViews ──────────────────────────────────────────────────

export async function listProjectViews(
  args: ListProjectViewsArgs
): Promise<ListProjectViewsResult> {
  const ownerCheck = assertSlug(args.owner, 'owner')
  if (!ownerCheck.ok) {
    return { ok: false, error: ownerCheck.error }
  }
  const numCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numCheck.ok) {
    return { ok: false, error: numCheck.error }
  }
  if (args.ownerType !== 'organization' && args.ownerType !== 'user') {
    return { ok: false, error: { type: 'validation_error', message: 'Invalid ownerType.' } }
  }
  const summaries: GitHubProjectViewSummary[] = []
  let cursor: string | null = null
  while (true) {
    const page = await fetchProjectViewsPage({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      host: args.host,
      after: cursor
    })
    if (!page.ok) {
      return { ok: false, error: page.error }
    }
    for (const v of page.views) {
      if (typeof v.id !== 'string' || typeof v.layout !== 'string') {
        continue
      }
      summaries.push({
        id: v.id,
        number: typeof v.number === 'number' ? v.number : 0,
        name: typeof v.name === 'string' ? v.name : '',
        layout: v.layout as GitHubProjectViewLayout
      })
    }
    if (!page.hasNextPage) {
      break
    }
    cursor = page.endCursor
    if (typeof cursor !== 'string') {
      break
    }
  }
  return { ok: true, views: summaries }
}
