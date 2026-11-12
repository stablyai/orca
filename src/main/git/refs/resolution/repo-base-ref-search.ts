import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import {
  clampRepoSearchRefsLimit,
  clampRepoSearchRefsScanLimit,
  REPO_SEARCH_REFS_DEFAULT_LIMIT,
  isRepoSearchRefsRequestLimit
} from '../../../../shared/repo-search-limits'
import { searchBranchRefSnapshot, snapshotRemoteNames } from '../snapshot/branch-ref-snapshot'
import type { LocalGitExecOptions } from './repo-default-base-ref'

export async function searchBaseRefs(
  path: string,
  query: string,
  limit = REPO_SEARCH_REFS_DEFAULT_LIMIT
): Promise<string[]> {
  if (!isRepoSearchRefsRequestLimit(limit)) {
    return []
  }
  const boundedLimit = clampRepoSearchRefsLimit(limit)
  return (await searchBaseRefDetails(path, query, boundedLimit)).map((entry) => entry.refName)
}

export async function searchBaseRefDetails(
  path: string,
  query: string,
  limit = REPO_SEARCH_REFS_DEFAULT_LIMIT,
  includeQualifiedRefs = true,
  git: LocalGitExecOptions = {}
): Promise<BaseRefSearchResult[]> {
  if (!isRepoSearchRefsRequestLimit(limit)) {
    return []
  }
  try {
    return await searchBranchRefSnapshot(
      path,
      query,
      clampRepoSearchRefsScanLimit(limit),
      includeQualifiedRefs,
      git
    )
  } catch (err) {
    console.warn('[searchBaseRefs] branch snapshot failed', { path, err })
    return []
  }
}

export async function listRemoteNames(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string[]> {
  try {
    return await snapshotRemoteNames(path, options)
  } catch {
    return []
  }
}
