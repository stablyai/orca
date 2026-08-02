import { LINEAR_ISSUE_API_PAGE_SIZE_MAX } from '../../shared/linear-issue-read-limits'

export type LinearPageVariables = { first: number; after?: string }

export type LinearConnection<T> = {
  nodes?: T[]
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
  }
} | null

export async function readConnectionPages<T>(
  limit: number,
  loadConnection: (page: LinearPageVariables) => Promise<LinearConnection<T>>
): Promise<{ nodes: T[]; hasMore: boolean }> {
  const nodes: T[] = []
  let after: string | undefined
  let hasMore = false

  while (nodes.length < limit) {
    // Why: Linear caps connection page sizes, so the CLI's larger context caps
    // must be reached by cursor walking rather than one oversized request.
    const first = Math.min(LINEAR_ISSUE_API_PAGE_SIZE_MAX, limit - nodes.length)
    const connection = await loadConnection(after ? { first, after } : { first })
    const pageNodes = connection?.nodes ?? []
    nodes.push(...pageNodes.slice(0, limit - nodes.length))
    hasMore = Boolean(connection?.pageInfo?.hasNextPage)

    const nextCursor = connection?.pageInfo?.endCursor ?? undefined
    if (!hasMore || !nextCursor || nextCursor === after || pageNodes.length === 0) {
      break
    }
    after = nextCursor
  }

  return { nodes, hasMore }
}
