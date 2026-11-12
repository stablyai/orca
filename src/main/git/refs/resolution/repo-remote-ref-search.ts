import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runSearchBaseRefsGit } from './repo-ref-search-command'
import {
  normalizeRefSearchQuery,
  parseAndFilterSearchRefDetails,
  mergeBaseRefSearchResultGroups
} from './repo-base-ref-search'

export async function searchRemoteRefPage(
  path: string,
  query: string,
  limit: number
): Promise<{ refDetails: BaseRefSearchResult[]; truncated: boolean }> {
  const { stdout } = await gitExecFileAsync(['remote'], { cwd: path })
  const remoteNames = stdout.split('\n').filter(Boolean)
  const normalized = normalizeRefSearchQuery(query)
  const groups: ('segmented' | 'branchRoot' | 'all')[] =
    normalized.split('/').filter(Boolean).length > 1 ? ['segmented', 'branchRoot'] : ['all']
  const results = await Promise.all(
    groups.map((patternGroup) =>
      runSearchBaseRefsGit(path, normalized, limit + 1, {
        namespace: 'remote',
        remoteNames,
        patternGroup
      })
    )
  )
  const candidates = mergeBaseRefSearchResultGroups(
    results.map((result) => parseAndFilterSearchRefDetails(result.stdout, limit + 1, remoteNames)),
    limit + 1
  )
  return {
    refDetails: candidates.slice(0, limit),
    truncated:
      candidates.length > limit ||
      results.some((result) => result.stdout.split('\n').filter(Boolean).length >= (limit + 1) * 4)
  }
}
