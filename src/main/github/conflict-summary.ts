import type { PRConflictSummary } from '../../shared/types'
import {
  isUnsupportedMergeTreeMergeBaseError,
  isUnsupportedMergeTreeWriteTreeError
} from '../../shared/git-merge-tree-capability'
import { gitExecFileAsync } from '../git/runner'
import {
  clearGitCapabilityStateForTests,
  getLocalGitCapabilityCache
} from '../git/git-capability-state'
import {
  __resetPRConflictSummaryDerivationCachesForTests,
  buildConflictSummaryCacheKey,
  dedupeBaseOidResolve,
  dedupeSummaryDerivation,
  getConflictSummaryGitRuntimeKey,
  readCachedSummary,
  readFreshBaseTipResolution,
  rememberUnresolvedBaseTip,
  storeResolvedBaseTip,
  storeCachedSummary
} from './conflict-summary-cache'

type LocalGitExecOptions = {
  wslDistro?: string
}

export function __resetPRConflictSummaryCachesForTests(): void {
  clearGitCapabilityStateForTests()
  __resetPRConflictSummaryDerivationCachesForTests()
}

export async function getPRConflictSummary(
  repoPath: string,
  baseRefName: string,
  baseRefOid: string,
  headRefOid: string,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRConflictSummary | undefined> {
  // Why: the renderer only needs a read-only merge-conflict snapshot. We
  // derive it from local git state so the PR card can show GitHub-style
  // detail without spending additional gh API calls on every refresh. We use
  // GitHub's head OID directly because the registered repo path may not have
  // a matching local branch name for the PR head. For the base side, prefer a
  // freshly-fetched remote-tracking ref so Orca matches GitHub's portal,
  // which compares against the latest base branch tip rather than the PR's
  // older pinned baseRefOid snapshot.
  const latestBaseOid = await resolveLatestBaseOidThrottled(
    repoPath,
    baseRefName,
    baseRefOid,
    localGitOptions
  )
  // Why: the summary is a pure function of the two commit OIDs, so a key hit
  // can skip the whole merge-base/rev-list/merge-tree subprocess chain.
  const runtimeKey = getConflictSummaryGitRuntimeKey(localGitOptions.wslDistro)
  const summaryKey = buildConflictSummaryCacheKey(
    runtimeKey,
    repoPath,
    baseRefName,
    headRefOid,
    latestBaseOid
  )
  const cached = readCachedSummary(summaryKey)
  if (cached) {
    return cached.value
  }

  // Why: different GitHub reads can report different pinned baseRefOid values
  // while still resolving to the same live base tip; dedupe the expensive
  // local derivation on the actual summary identity.
  return dedupeSummaryDerivation(summaryKey, () =>
    derivePRConflictSummary(
      repoPath,
      baseRefName,
      headRefOid,
      latestBaseOid,
      summaryKey,
      localGitOptions
    )
  )
}

async function derivePRConflictSummary(
  repoPath: string,
  baseRefName: string,
  headRefOid: string,
  latestBaseOid: string,
  summaryKey: string,
  localGitOptions: LocalGitExecOptions
): Promise<PRConflictSummary | undefined> {
  const cached = readCachedSummary(summaryKey)
  if (cached) {
    return cached.value
  }

  try {
    const mergeBase = await resolveMergeBase(repoPath, headRefOid, latestBaseOid, localGitOptions)
    const [commitsBehind, files] = await Promise.all([
      countCommits(repoPath, `${headRefOid}..${latestBaseOid}`, localGitOptions),
      loadConflictingFiles(repoPath, mergeBase, headRefOid, latestBaseOid, localGitOptions)
    ])

    const summary = {
      baseRef: baseRefName,
      baseCommit: latestBaseOid.slice(0, 7),
      commitsBehind,
      files,
      ...(files.length === 0 ? { localMergeState: 'clean' as const } : {})
    }
    storeCachedSummary(summaryKey, summary)
    return summary
  } catch {
    storeCachedSummary(summaryKey, undefined)
    return undefined
  }
}

async function resolveLatestBaseOidThrottled(
  repoPath: string,
  baseRefName: string,
  fallbackBaseOid: string,
  localGitOptions: LocalGitExecOptions
): Promise<string> {
  const runtimeKey = getConflictSummaryGitRuntimeKey(localGitOptions.wslDistro)
  const baseKey = buildConflictSummaryCacheKey(runtimeKey, repoPath, baseRefName)
  const cachedResolution = readFreshBaseTipResolution(baseKey)
  if (cachedResolution) {
    return cachedResolution.kind === 'resolved' ? cachedResolution.oid : fallbackBaseOid
  }
  return dedupeBaseOidResolve(baseKey, async () => {
    // Why re-check inside the dedupe slot: a sibling caller may have finished
    // resolving between our cache read and this factory starting.
    const freshResolution = readFreshBaseTipResolution(baseKey)
    if (freshResolution) {
      return freshResolution
    }
    const oid = await resolveLatestBaseOid(repoPath, baseRefName, localGitOptions)
    if (oid) {
      storeResolvedBaseTip(baseKey, oid)
      return { kind: 'resolved', oid }
    }
    // Why cache the unresolved probe, not the caller fallback: the fetch
    // attempt is branch-wide expensive work, but GitHub's baseRefOid is
    // PR-specific and must not leak to sibling PRs on the same base branch.
    rememberUnresolvedBaseTip(baseKey)
    return { kind: 'fallback-unresolved' }
  }).then((resolution) => (resolution.kind === 'resolved' ? resolution.oid : fallbackBaseOid))
}

async function resolveLatestBaseOid(
  repoPath: string,
  baseRefName: string,
  localGitOptions: LocalGitExecOptions
): Promise<string | null> {
  const remoteName = 'origin'

  try {
    // Why: cap the fetch at 10 s so slow or unreachable remotes don't block
    // the conflict-summary derivation indefinitely.
    await gitExecFileAsync(['fetch', '--quiet', remoteName, baseRefName], {
      cwd: repoPath,
      timeout: 10_000,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
    })
  } catch {
    // Why: fetching the base ref keeps the conflict list aligned with GitHub's
    // live mergeability view, but the card must still render offline. If fetch
    // fails, fall back to the base OID GitHub already gave us.
  }

  for (const ref of [`refs/remotes/${remoteName}/${baseRefName}`, `${remoteName}/${baseRefName}`]) {
    try {
      const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', ref], {
        cwd: repoPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
      })
      const oid = stdout.trim()
      if (oid) {
        return oid
      }
    } catch {
      // Try the next ref form before falling back to GitHub's baseRefOid.
    }
  }

  return null
}

async function resolveMergeBase(
  repoPath: string,
  headOid: string,
  baseOid: string,
  localGitOptions: LocalGitExecOptions
): Promise<string> {
  const { stdout } = await gitExecFileAsync(['merge-base', headOid, baseOid], {
    cwd: repoPath,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  })
  return stdout.trim()
}

async function countCommits(
  repoPath: string,
  range: string,
  localGitOptions: LocalGitExecOptions
): Promise<number> {
  const { stdout } = await gitExecFileAsync(['rev-list', '--count', range], {
    cwd: repoPath,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  })
  return Number.parseInt(stdout.trim(), 10) || 0
}

async function loadConflictingFiles(
  repoPath: string,
  mergeBase: string,
  headOid: string,
  baseOid: string,
  localGitOptions: LocalGitExecOptions
): Promise<string[]> {
  const capabilities = getLocalGitCapabilityCache({
    cwd: repoPath,
    wslDistro: localGitOptions.wslDistro
  })
  const modernArgs = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    '--merge-base',
    mergeBase,
    headOid,
    baseOid
  ]
  const legacyArgs = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    headOid,
    baseOid
  ]

  return capabilities.runWithFallback(
    'merge-tree-write-tree',
    () =>
      capabilities.runWithFallback(
        'merge-tree-merge-base',
        async () => {
          try {
            const result = await gitExecFileAsync(modernArgs, {
              cwd: repoPath,
              ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
            })
            return parseMergeTreeNameOnlyOutput(result.stdout)
          } catch (error) {
            if (isUnsupportedMergeTreeWriteTreeError(error)) {
              throw error
            }
            // Why: `git merge-tree --write-tree` exits 1 for conflicts but still
            // writes the useful file list; only option rejection reaches fallback.
            const stdoutFromError = getGitErrorOutput(error, 'stdout')
            if (stdoutFromError) {
              return parseMergeTreeNameOnlyOutput(stdoutFromError)
            }
            throw error
          }
        },
        () => loadConflictingFilesWithLegacyMergeTree(repoPath, legacyArgs, localGitOptions),
        isUnsupportedMergeTreeMergeBaseError
      ),
    async () => {
      // Why: Git before 2.38 cannot derive a reliable real-merge conflict list;
      // fail closed without respawning the same rejected command every refresh.
      throw new Error('Git merge-tree --write-tree is unavailable on this execution host.')
    },
    isUnsupportedMergeTreeWriteTreeError
  )
}

async function loadConflictingFilesWithLegacyMergeTree(
  repoPath: string,
  legacyArgs: string[],
  localGitOptions: LocalGitExecOptions
): Promise<string[]> {
  try {
    const result = await gitExecFileAsync(legacyArgs, {
      cwd: repoPath,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
    })
    return parseMergeTreeNameOnlyOutput(result.stdout)
  } catch (fallbackError) {
    const fallbackStdout = getGitErrorOutput(fallbackError, 'stdout')
    if (fallbackStdout) {
      return parseMergeTreeNameOnlyOutput(fallbackStdout)
    }
    throw fallbackError
  }
}

function parseMergeTreeNameOnlyOutput(stdout: string): string[] {
  const entries = stdout.split('\0').filter(Boolean)
  if (entries.length === 0) {
    return []
  }

  const [, ...files] = entries
  return files
}

function getGitErrorOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (typeof error !== 'object' || error === null) {
    return ''
  }
  const output = (error as Partial<Record<'stdout' | 'stderr', unknown>>)[key]
  return typeof output === 'string' ? output : ''
}
