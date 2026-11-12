import { isForEachRefExcludeUnsupportedError } from '../../shared/git/refs/git-ref-command-capabilities'
import {
  clampRepoSearchRefsScanLimit,
  isRepoSearchRefsScanLimit
} from '../../shared/repo-search-limits'
import { isSafeGitRefName } from '../../shared/git/status/git-status-upstream-ref'
import { getLocalGitCapabilityCache } from './command-runner/host-routing/git-capability-state'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from './command-runner/git-exec-file'

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

/** Exclude direct remote HEAD slots while preserving nested branch names ending in HEAD. */
function getRemoteHeadExcludes(remoteNames: readonly string[] | undefined): string[] {
  if (remoteNames && remoteNames.length > 0) {
    // Ordinary remotes share a wildcard; slash-containing remotes need exact excludes.
    const slashRemotes = [...new Set(remoteNames)].filter(
      (remote) => remote.includes('/') && isSafeGitRefName(`refs/remotes/${remote}/HEAD`)
    )
    return [
      '--exclude=refs/remotes/*/HEAD',
      ...slashRemotes.map((remote) => `--exclude=refs/remotes/${remote}/HEAD`)
    ]
  }
  // * does not cross slashes, so unknown nested remotes remain eligible.
  return ['--exclude=refs/remotes/*/HEAD']
}

/** Build the bounded `for-each-ref` argv shared by local and remote searches. */
export function buildSearchBaseRefsArgv(
  normalizedQuery: string,
  limit: number,
  options: {
    excludeRemoteHead?: boolean
    remoteNames?: readonly string[]
    namespace?: 'remote'
    patternGroup?: RefSearchPatternGroup
  } = {}
): string[] {
  const excludeRemoteHead = options.excludeRemoteHead ?? true
  // Bound the Git scan even when the caller asks for more retained rows.
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
      ...[
        `refs/heads/**/*${query}*`,
        `refs/heads/**/*${query}*/**`,
        `refs/remotes/**/*${query}*`,
        `refs/remotes/**/*${query}*/**`
      ].filter((pattern) => options.namespace !== 'remote' || pattern.startsWith('refs/remotes/'))
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
  return [
    ...base,
    ...patterns.filter(
      (pattern) => options.namespace !== 'remote' || pattern.startsWith('refs/remotes/')
    )
  ]
}

export async function runSearchBaseRefsGit(
  path: string,
  normalizedQuery: string,
  limit: number,
  options: {
    remoteNames: readonly string[]
    namespace?: 'remote'
    patternGroup?: RefSearchPatternGroup
    git?: LocalGitExecOptions
  }
): Promise<{ stdout: string }> {
  const execOptions = gitExecOptions(path, options.git)
  return getLocalGitCapabilityCache(execOptions).runWithFallback(
    'for-each-ref-exclude',
    () =>
      gitExecFileAsync(
        buildSearchBaseRefsArgv(normalizedQuery, limit, {
          namespace: options.namespace,
          remoteNames: options.remoteNames,
          patternGroup: options.patternGroup
        }),
        execOptions
      ),
    () =>
      gitExecFileAsync(
        buildSearchBaseRefsArgv(normalizedQuery, limit, {
          excludeRemoteHead: false,
          namespace: options.namespace,
          remoteNames: options.remoteNames,
          patternGroup: options.patternGroup
        }),
        execOptions
      ),
    isForEachRefExcludeUnsupportedError
  )
}
