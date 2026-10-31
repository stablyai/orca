import type { PRConflictSummary } from '../../shared/github/pull-request-types'
import {
  isUnsupportedMergeTreeMergeBaseError,
  isUnsupportedMergeTreeWriteTreeError
} from '../../shared/git-merge-tree-capability'
import { gitExecFileAsync } from '../git/runner'
import { gitOptionsForWorktree, type GitRuntimeOptions } from '../git/git-runtime-options'
import { createLocalGitObjectQuarantine } from '../git/local-git-object-quarantine'
import { _resetCanonicalRepoKeyCacheForTests } from '../git/canonical-repo-key'
import { RuntimeRemoteFetchController } from '../runtime/runtime-remote-fetch-controller'
import {
  clearGitCapabilityStateForTests,
  withLocalGitCapabilityCacheForExecution
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

type LocalGitExecOptions = Pick<GitRuntimeOptions, 'wslDistro' | 'admissionTier'>
type BaseRefreshController = Pick<
  RuntimeRemoteFetchController,
  'refreshRemoteTrackingBaseForPreview'
>

let remoteFetches: BaseRefreshController | null = null

export function setPRConflictSummaryRemoteFetches(controller: BaseRefreshController): void {
  remoteFetches = controller
}

export function __resetPRConflictSummaryCachesForTests(): void {
  clearGitCapabilityStateForTests()
  __resetPRConflictSummaryDerivationCachesForTests()
  _resetCanonicalRepoKeyCacheForTests()
  remoteFetches = null
}

export async function getPRConflictSummary(
  repoPath: string,
  baseRefName: string,
  baseRefOid: string,
  headRefOid: string,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRConflictSummary | undefined> {
  // Use GitHub's head OID when no local branch exists, and refresh the live base to match current mergeability.
  const latestBaseOid = await resolveLatestBaseOidThrottled(
    repoPath,
    baseRefName,
    baseRefOid,
    localGitOptions
  )
  // Immutable commit pairs let cache hits skip the entire Git derivation.
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

  // Distinct pinned base snapshots can resolve to one live tip; dedupe by the actual commit pair.
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
    // Another caller can resolve the base between the first cache read and this factory.
    const freshResolution = readFreshBaseTipResolution(baseKey)
    if (freshResolution) {
      return freshResolution
    }
    const oid = await resolveLatestBaseOid(repoPath, baseRefName, localGitOptions)
    if (oid) {
      storeResolvedBaseTip(baseKey, oid)
      return { kind: 'resolved', oid }
    }
    // Cache unresolved branch-wide probes, not each PR's distinct fallback base OID.
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
  const trackingRef = `refs/remotes/${remoteName}/${baseRefName}`
  remoteFetches ??= new RuntimeRemoteFetchController()
  // Keep cards available offline: failed refreshes fall back to local refs, then GitHub's base OID.
  await remoteFetches.refreshRemoteTrackingBaseForPreview(
    repoPath,
    {
      remote: remoteName,
      branch: baseRefName,
      ref: trackingRef,
      base: `${remoteName}/${baseRefName}`
    },
    localGitOptions
  )

  for (const ref of [trackingRef, `${remoteName}/${baseRefName}`]) {
    try {
      const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', ref], {
        ...gitOptionsForWorktree(repoPath, localGitOptions)
      })
      const oid = stdout.trim()
      if (oid) {
        return oid
      }
    } catch {
      // Continue through ref forms before falling back to GitHub's base OID.
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
    ...gitOptionsForWorktree(repoPath, localGitOptions)
  })
  return stdout.trim()
}

async function countCommits(
  repoPath: string,
  range: string,
  localGitOptions: LocalGitExecOptions
): Promise<number> {
  const { stdout } = await gitExecFileAsync(['rev-list', '--count', range], {
    ...gitOptionsForWorktree(repoPath, localGitOptions)
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
  // Quarantine the unused merged tree so preview reads cannot accumulate loose objects.
  const quarantine = createLocalGitObjectQuarantine(repoPath, localGitOptions)

  return withLocalGitCapabilityCacheForExecution(
    { cwd: repoPath, wslDistro: localGitOptions.wslDistro },
    (capabilities) => {
      const runMergeTree = (args: string[]): Promise<{ stdout: string }> => {
        const run = (env: NodeJS.ProcessEnv | undefined) =>
          gitExecFileAsync(args, {
            ...gitOptionsForWorktree(repoPath, localGitOptions),
            ...(env ? { env } : {})
          })
        // Probe support before creating a quarantine that older Git cannot prune.
        return capabilities.isKnownSupported('merge-tree-write-tree')
          ? quarantine.run(run)
          : run(undefined)
      }
      return capabilities.runWithFallback(
        'merge-tree-write-tree',
        () =>
          capabilities.runWithFallback(
            'merge-tree-merge-base',
            async () => {
              try {
                const result = await runMergeTree(modernArgs)
                return parseMergeTreeNameOnlyOutput(result.stdout)
              } catch (error) {
                if (isUnsupportedMergeTreeWriteTreeError(error)) {
                  throw error
                }
                // Conflicts exit 1 but still provide the file list; option rejection alone triggers fallback.
                const stdoutFromError = getGitErrorOutput(error, 'stdout')
                if (stdoutFromError) {
                  return parseMergeTreeNameOnlyOutput(stdoutFromError)
                }
                throw error
              }
            },
            () => loadConflictingFilesWithLegacyMergeTree(runMergeTree, legacyArgs),
            isUnsupportedMergeTreeMergeBaseError
          ),
        async () => {
          // Older Git cannot derive a reliable merge-conflict list; cache the unsupported capability.
          throw new Error('Git merge-tree --write-tree is unavailable on this execution host.')
        },
        isUnsupportedMergeTreeWriteTreeError
      )
    }
  )
}

async function loadConflictingFilesWithLegacyMergeTree(
  runMergeTree: (args: string[]) => Promise<{ stdout: string }>,
  legacyArgs: string[]
): Promise<string[]> {
  try {
    const result = await runMergeTree(legacyArgs)
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
