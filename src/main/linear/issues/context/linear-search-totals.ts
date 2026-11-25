import type { LinearSearchIssueSummary } from '../../../../shared/linear/agent-result-types'

export type WorkspaceSearchResult = { issues: LinearSearchIssueSummary[]; totalCount?: number }

// Why: a total is only true when every attempted workspace reported its own count.
export function sumSearchTotals(
  results: WorkspaceSearchResult[],
  attemptedWorkspaceCount: number
): number | undefined {
  if (results.length !== attemptedWorkspaceCount) {
    return undefined
  }
  let total = 0
  for (const result of results) {
    if (result.totalCount === undefined) {
      return undefined
    }
    total += result.totalCount
  }
  return total
}
