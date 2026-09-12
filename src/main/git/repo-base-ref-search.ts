import type { BaseRefSearchResult } from '../../shared/repo-types'
import { isForEachRefExcludeUnsupportedError } from '../../shared/git-ref-command-capabilities'
import {
  clampRepoSearchRefsLimit,
  clampRepoSearchRefsScanLimit,
  REPO_SEARCH_REFS_DEFAULT_LIMIT,
  isRepoSearchRefsRequestLimit,
  isRepoSearchRefsScanLimit
} from '../../shared/repo-search-limits'
import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import { isRemoteHeadRef } from '../../shared/hosted-review-refs'
import { getLocalGitCapabilityCache } from './git-capability-state'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from './runner'

const REF_SEARCH_CANDIDATE_MULTIPLIER = 4
const REF_SEARCH_LEGACY_HEADROOM = 100

type RefSearchPatternGroup = 'all' | 'segmented' | 'branchRoot'

function getRefSearchTokens(normalizedQuery: string): string[] {
  return normalizedQuery.split('/').filter((token) => token.length > 0)
}

function getRefSearchCandidateCount(limit: number, excludesRemoteHead: boolean): number {
  if (!isRepoSearchRefsScanLimit(limit)) {
    throw new Error('invalid_limit')
  }
  const baseCount = limit * REF_SEARCH_CANDIDATE_MULTIPLIER
  return excludesRemoteHead ? baseCount : baseCount + REF_SEARCH_LEGACY_HEADROOM
}

/** Build excludes for the symbolic `<remote>/HEAD` slot without hiding
 * nested branch names such as `<remote>/feature/HEAD`. */
function getRemoteHeadExcludes(remoteNames: readonly string[] | undefined): string[] {
  if (remoteNames && remoteNames.length > 0) {
    // A single-component wildcard covers the overwhelmingly common remote
    // shape. Keep exact excludes only for slash-containing remote names, where
    // that wildcard cannot reach the direct `<remote>/HEAD` slot without also
    // hiding legal nested branches such as `<remote>/feature/HEAD`.
    const slashRemotes = [...new Set(remoteNames)].filter(
      (remote) => remote.includes('/') && isSafeGitRefName(`refs/remotes/${remote}/HEAD`)
    )
    return [
      '--exclude=refs/remotes/*/HEAD',
      ...slashRemotes.map((remote) => `--exclude=refs/remotes/${remote}/HEAD`)
    ]
  }
  // `*` does not cross `/`, unlike `**`; this keeps unknown nested remotes
  // eligible for the parser's branch-name matching.
  return ['--exclude=refs/remotes/*/HEAD']
}

/** Build the bounded `for-each-ref` argv shared by local and remote searches. */
export function buildSearchBaseRefsArgv(
  normalizedQuery: string,
  limit: number,
  options: {
    excludeRemoteHead?: boolean
    remoteNames?: readonly string[]
    patternGroup?: RefSearchPatternGroup
  } = {}
): string[] {
  const excludeRemoteHead = options.excludeRemoteHead ?? true
  // A caller may ask for more rows than the retained-result cap. Keep that
  // request useful while bounding the Git command to the safe probe window.
  const boundedScanLimit = clampRepoSearchRefsScanLimit(limit)
  const candidateCount = getRefSearchCandidateCount(boundedScanLimit, excludeRemoteHead)
  const base = [
    'for-each-ref',
    '--format=%(refname)%00%(refname:short)',
    '--sort=-committerdate',
    ...(excludeRemoteHead ? getRemoteHeadExcludes(options.remoteNames) : []),
    `--count=${candidateCount}`
  ]
  const tokens = getRefSearchTokens(normalizedQuery)
  if (tokens.length <= 1) {
    const query = tokens[0] ?? ''
    return [
      ...base,
      `refs/heads/**/*${query}*`,
      `refs/heads/**/*${query}*/**`,
      `refs/remotes/**/*${query}*`,
      `refs/remotes/**/*${query}*/**`
    ]
  }

  const segmented = tokens.map((token) => `*${token}*`).join('/')
  const substringQuery = tokens.join('/')
  const remoteBranchRootPatterns =
    options.remoteNames && options.remoteNames.length > 0
      ? options.remoteNames.flatMap((remote) => [
          `refs/remotes/${remote}/${substringQuery}*`,
          `refs/remotes/${remote}/${substringQuery}*/**`
        ])
      : [`refs/remotes/*/${substringQuery}*`, `refs/remotes/*/${substringQuery}*/**`]
  const segmentedPatterns = [`refs/remotes/${segmented}`, `refs/heads/${segmented}`]
  const branchRootPatterns = [
    `refs/heads/${substringQuery}*`,
    `refs/heads/${substringQuery}*/**`,
    ...remoteBranchRootPatterns
  ]
  const patterns =
    options.patternGroup === 'segmented'
      ? segmentedPatterns
      : options.patternGroup === 'branchRoot'
        ? branchRootPatterns
        : [...segmentedPatterns, ...branchRootPatterns]
  return [...base, ...patterns]
}

async function runSearchBaseRefsGit(
  path: string,
  normalizedQuery: string,
  limit: number,
  options: { remoteNames: readonly string[]; patternGroup?: RefSearchPatternGroup }
): Promise<{ stdout: string }> {
  return getLocalGitCapabilityCache({ cwd: path }).runWithFallback(
    'for-each-ref-exclude',
    () =>
      gitExecFileAsync(
        buildSearchBaseRefsArgv(normalizedQuery, limit, {
          remoteNames: options.remoteNames,
          patternGroup: options.patternGroup
        }),
        { cwd: path }
      ),
    () =>
      gitExecFileAsync(
        buildSearchBaseRefsArgv(normalizedQuery, limit, {
          excludeRemoteHead: false,
          remoteNames: options.remoteNames,
          patternGroup: options.patternGroup
        }),
        { cwd: path }
      ),
    isForEachRefExcludeUnsupportedError
  )
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
  limit = REPO_SEARCH_REFS_DEFAULT_LIMIT
): Promise<BaseRefSearchResult[]> {
  if (!isRepoSearchRefsRequestLimit(limit)) {
    return []
  }
  const boundedScanLimit = clampRepoSearchRefsScanLimit(limit)
  const normalizedQuery = normalizeRefSearchQuery(query)

  try {
    const remotes = await listRemoteNames(path)
    const tokens = getRefSearchTokens(normalizedQuery)
    if (tokens.length > 1) {
      const results = await Promise.all([
        runSearchBaseRefsGit(path, normalizedQuery, boundedScanLimit, {
          remoteNames: remotes,
          patternGroup: 'segmented'
        }),
        runSearchBaseRefsGit(path, normalizedQuery, boundedScanLimit, {
          remoteNames: remotes,
          patternGroup: 'branchRoot'
        })
      ])
      return mergeBaseRefSearchResultGroups(
        results.map((entry) =>
          parseAndFilterSearchRefDetails(entry.stdout, boundedScanLimit, remotes)
        ),
        boundedScanLimit
      )
    }

    const result = await runSearchBaseRefsGit(path, normalizedQuery, boundedScanLimit, {
      remoteNames: remotes
    })
    return parseAndFilterSearchRefDetails(result.stdout, boundedScanLimit, remotes)
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
  remotes: string[] = []
): BaseRefSearchResult[] {
  const seen = new Set<string>()
  const sortedRemotes = [...remotes].sort((a, b) => b.length - a.length)

  const canonicalShortRef = (fullRef: string, gitShortRef: string): string => {
    // Git's refname:short DWIM rule can strip a trailing `/HEAD` (for example,
    // `refs/remotes/origin/feature/HEAD` becomes `origin/feature`). Derive the
    // display name only for that case; otherwise Git's disambiguation prefixes
    // (such as `heads/` and `remotes/`) are significant and must be retained.
    if (
      fullRef.startsWith('refs/remotes/') &&
      fullRef.endsWith('/HEAD') &&
      !gitShortRef.endsWith('/HEAD')
    ) {
      return fullRef.slice('refs/remotes/'.length)
    }
    return gitShortRef
  }

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
      return { full, short: canonicalShortRef(full, gitShort) }
    })
    .filter((entry): entry is { full: string; short: string } => entry !== null)
    .filter(({ full }) => !isRemoteHeadRef(full, sortedRemotes))
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
