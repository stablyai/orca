import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import {
  clampRepoSearchRefsLimit,
  clampRepoSearchRefsScanLimit,
  REPO_SEARCH_REFS_DEFAULT_LIMIT,
  isRepoSearchRefsRequestLimit
} from '../../../../shared/repo-search-limits'
import { isSafeGitRefName } from '../../../../shared/git/status/git-status-upstream-ref'
import { isRemoteHeadRef } from '../../../../shared/source-control/hosted-review/hosted-review-refs'
import { runSearchBaseRefsGit } from './repo-ref-search-command'

import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { isQualifiedBaseRef, resolveBaseRefSearchSelector } from './base-ref-search-selector'

type RefSearchPatternGroup = 'all' | 'segmented' | 'branchRoot'
function getRefSearchTokens(query: string) {
  return query.split('/').filter(Boolean)
}

export function mergeBaseRefSearchResultGroups(
  groups: readonly BaseRefSearchResult[][],
  limit: number
): BaseRefSearchResult[] {
  const seen = new Set<string>()
  const merged: BaseRefSearchResult[] = []
  const maxLength = Math.max(0, ...groups.map((group) => group.length))
  for (let index = 0; index < maxLength && merged.length < limit; index += 1) {
    for (const group of groups) {
      const entry = group[index]
      if (!entry || seen.has(entry.refName)) {
        continue
      }
      seen.add(entry.refName)
      merged.push(entry)
      if (merged.length >= limit) {
        break
      }
    }
  }
  return merged
}

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
  const boundedScanLimit = clampRepoSearchRefsScanLimit(limit)
  const normalizedQuery = normalizeRefSearchQuery(query)

  try {
    const remotes = await listRemoteNames(path, git)
    const search = (patternGroup?: RefSearchPatternGroup): Promise<{ stdout: string }> =>
      runSearchBaseRefsGit(path, normalizedQuery, boundedScanLimit, {
        remoteNames: remotes,
        patternGroup,
        git
      })
    const tokens = getRefSearchTokens(normalizedQuery)
    if (tokens.length > 1) {
      const results = await Promise.all([search('segmented'), search('branchRoot')])
      return mergeBaseRefSearchResultGroups(
        results.map((entry) =>
          parseAndFilterSearchRefDetails(
            entry.stdout,
            boundedScanLimit,
            remotes,
            includeQualifiedRefs
          )
        ),
        boundedScanLimit
      )
    }

    const result = await search()
    return parseAndFilterSearchRefDetails(
      result.stdout,
      boundedScanLimit,
      remotes,
      includeQualifiedRefs
    )
  } catch (err) {
    console.warn('[searchBaseRefs] for-each-ref failed', { path, err })
    return []
  }
}

export async function listRemoteNames(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(['remote'], gitExecOptions(path, options))
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function parseAndFilterSearchRefDetails(
  stdout: string,
  limit: number,
  remotes: string[] = [],
  includeQualifiedRefs = true
): BaseRefSearchResult[] {
  const seen = new Set<string>()
  const sortedRemotes = [...remotes].sort((a, b) => b.length - a.length)

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const nul = line.indexOf('\0')
      if (nul === -1) {
        return null
      }
      const full = line.slice(0, nul)
      const gitShort = line.slice(nul + 1)
      return { full, short: resolveBaseRefSearchSelector(full, gitShort) }
    })
    .filter((entry): entry is { full: string; short: string } => entry !== null)
    .filter(({ full }) => isSafeGitRefName(full) && !isRemoteHeadRef(full, sortedRemotes))
    .filter(({ short }) => includeQualifiedRefs || !isQualifiedBaseRef(short))
    .filter(({ short }) => {
      if (seen.has(short)) {
        return false
      }
      seen.add(short)
      return true
    })
    .map(({ full, short }) => ({
      refName: short,
      localBranchName: resolveLocalBranchName(full, short, sortedRemotes)
    }))
    .slice(0, Math.max(0, limit))
}

export function resolveConfiguredRemoteBranchName(
  fullRef: string,
  longestFirstRemoteNames: readonly string[]
): string | null {
  const remoteRefPrefix = 'refs/remotes/'
  if (!fullRef.startsWith(remoteRefPrefix)) {
    return null
  }
  const remoteAndBranch = fullRef.slice(remoteRefPrefix.length)
  const remote = longestFirstRemoteNames.find((candidate) =>
    remoteAndBranch.startsWith(`${candidate}/`)
  )
  return remote ? remoteAndBranch.slice(remote.length + 1) || null : null
}

export function resolveLocalBranchName(
  fullRef: string,
  shortRef: string,
  remotes: string[]
): string {
  const localRefPrefix = 'refs/heads/'
  if (fullRef.startsWith(localRefPrefix)) {
    return fullRef.slice(localRefPrefix.length) || shortRef
  }
  const remoteRefPrefix = 'refs/remotes/'
  if (!fullRef.startsWith(remoteRefPrefix)) {
    return shortRef
  }
  const configuredBranch = resolveConfiguredRemoteBranchName(fullRef, remotes)
  if (configuredBranch) {
    return configuredBranch
  }
  const remoteAndBranch = fullRef.slice(remoteRefPrefix.length)
  return remoteAndBranch.split('/').slice(1).join('/') || shortRef
}

export function normalizeRefSearchQuery(query: string): string {
  return query.trim().replace(/[*?[\]\\]/g, '')
}
