import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import {
  clampRepoSearchRefsLimit,
  getRepoSearchRefsProbeLimit
} from '../../../../shared/repo-search-limits'
import { searchBranchRefSnapshot } from '../snapshot/branch-ref-snapshot'

export async function searchRemoteRefPage(
  path: string,
  query: string,
  limit: number,
  includeQualifiedRefs = true
): Promise<{ refDetails: BaseRefSearchResult[]; truncated: boolean }> {
  const bounded = clampRepoSearchRefsLimit(limit)
  const candidates = await searchBranchRefSnapshot(
    path,
    query,
    getRepoSearchRefsProbeLimit(bounded),
    includeQualifiedRefs,
    {},
    true
  )
  return {
    refDetails: candidates.slice(0, bounded),
    truncated: limit > bounded || candidates.length > bounded
  }
}
