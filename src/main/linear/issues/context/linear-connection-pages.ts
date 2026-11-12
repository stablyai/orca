import { LINEAR_ISSUE_API_PAGE_SIZE_MAX } from '../../../../shared/linear/issue-read-limits'
import { linearError } from './linear-access-errors'

export type LinearPageVariables = { first: number; after?: string }

export type LinearConnection<T> = {
  nodes?: T[]
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
  }
} | null

export function linearConnectionHasNextPage(
  connection: { pageInfo?: { hasNextPage?: unknown } | null } | null | undefined
): boolean {
  // Why: a null connection is an empty read. A connection whose hasNextPage is
  // not boolean is not evidence that the caller already has the full set.
  if (connection == null) {
    return false
  }
  const hasNext = connection.pageInfo?.hasNextPage
  if (typeof hasNext !== 'boolean') {
    throw linearError(
      'linear_partial',
      'Linear omitted pageInfo, so this read cannot be treated as complete.'
    )
  }
  return hasNext
}

export async function readConnectionPages<T>(
  limit: number,
  loadConnection: (page: LinearPageVariables) => Promise<LinearConnection<T>>,
  pageSize = LINEAR_ISSUE_API_PAGE_SIZE_MAX
): Promise<{ nodes: T[]; hasMore: boolean }> {
  const nodes: T[] = []
  let after: string | undefined
  let hasMore = false

  while (nodes.length < limit) {
    // Walk capped backend pages to satisfy larger context limits.
    const first = Math.min(LINEAR_ISSUE_API_PAGE_SIZE_MAX, pageSize, limit - nodes.length)
    const connection = await loadConnection(after ? { first, after } : { first })
    const pageNodes = connection?.nodes ?? []
    nodes.push(...pageNodes.slice(0, limit - nodes.length))
    hasMore = linearConnectionHasNextPage(connection)

    const nextCursor = connection?.pageInfo?.endCursor ?? undefined
    if (!hasMore || !nextCursor || nextCursor === after || pageNodes.length === 0) {
      break
    }
    after = nextCursor
  }

  return { nodes, hasMore }
}
