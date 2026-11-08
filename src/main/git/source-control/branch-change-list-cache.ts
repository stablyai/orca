import type { GitBranchChangeEntry } from '../../../shared/git/diff/git-diff-compare-types'
import { gitChangeListArgs } from '../../../shared/git/diff/git-change-list'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { loadBranchChanges } from './branch-change-entries'
import type { CommitPairScope } from './commit-pair-cache'
import { addGitattributesStampPaths } from './gitattributes-stamp-paths'
import { SettledDiffCache, type SettledDiffCacheLimits } from './settled-diff-cache'
import { readStampedGitConfig } from './stamped-git-config'
import { readWorktreePathsDiffStamp } from './worktree-diff-stamp'

type CachedBranchChanges = {
  entries: GitBranchChangeEntry[]
  /** Worktree `.gitattributes` files that shape the listed paths' numstat (for example `-diff`). */
  attributePaths: string[]
}

// Statting more attribute files than this approaches the cost of the diff it would skip.
const MAX_ATTRIBUTE_STAMP_PATHS = 8192

const BRANCH_CHANGE_LIST_CACHE_LIMITS: SettledDiffCacheLimits<CachedBranchChanges> = {
  maxEntries: 16,
  maxCharacters: 16_000_000,
  maxEntryCharacters: 4_000_000,
  // Paths dominate; status, counts and object overhead are a few dozen characters each.
  characterCount: ({ entries, attributePaths }) => {
    let characters = 0
    for (const entry of entries) {
      characters += entry.path.length + (entry.oldPath?.length ?? 0) + 32
    }
    for (const attributePath of attributePaths) {
      characters += attributePath.length
    }
    return characters
  }
}

export const settledBranchChangeListCache = new SettledDiffCache(BRANCH_CHANGE_LIST_CACHE_LIMITS)

/** Rollback switch: `ORCA_GIT_BRANCH_CHANGES_REUSE=0` reruns the changed-files diff on every poll. */
function isBranchChangeListReuseEnabled(): boolean {
  return process.env.ORCA_GIT_BRANCH_CHANGES_REUSE !== '0'
}

function attributeStampPaths(entries: readonly GitBranchChangeEntry[]): string[] | null {
  const paths = new Set<string>()
  for (const entry of entries) {
    addGitattributesStampPaths(paths, entry.path)
    if (entry.oldPath !== undefined) {
      addGitattributesStampPaths(paths, entry.oldPath)
    }
    if (paths.size > MAX_ATTRIBUTE_STAMP_PATHS) {
      return null
    }
  }
  return [...paths]
}

/** Reuse a commit pair's changed-files list while config, attributes, HEAD and index are provably unchanged. */
export async function loadBranchChangesThroughCache(
  worktreePath: string,
  pairScope: CommitPairScope | null,
  rereadPairScope: () => Promise<CommitPairScope | null>,
  mergeBase: string,
  headOid: string,
  options: GitRuntimeOptions
): Promise<GitBranchChangeEntry[]> {
  const compute = () => loadBranchChanges(worktreePath, mergeBase, headOid, options)
  // A tree attribute source (attr.tree, GIT_ATTR_SOURCE) can move with a ref no stamp covers.
  if (pairScope === null || !isBranchChangeListReuseEnabled() || process.env.GIT_ATTR_SOURCE) {
    return compute()
  }
  const config = await readStampedGitConfig(worktreePath, options)
  if (!config || config.values.has('attr.tree')) {
    return compute()
  }
  const settingsFiles = [...config.files, ...config.attributeFiles]
  const stampAttributes = (attributePaths: readonly string[]) =>
    readWorktreePathsDiffStamp(worktreePath, attributePaths, options, settingsFiles)
  const key = JSON.stringify([pairScope, worktreePath, gitChangeListArgs(mergeBase, headOid)])

  const cached = settledBranchChangeListCache.peek(key)
  if (cached) {
    const reused = settledBranchChangeListCache.get(
      key,
      await stampAttributes(cached.attributePaths)
    )
    if (reused) {
      return reused.entries
    }
  }

  const readGeneration = settledBranchChangeListCache.beginRead()
  const readStartedAtMs = Date.now()
  const entries = await compute()
  const attributePaths = attributeStampPaths(entries)
  if (!attributePaths) {
    return entries
  }
  const [stamp, scopeAfterRead] = await Promise.all([
    stampAttributes(attributePaths),
    rereadPairScope()
  ])
  // A history rewrite during the diff would file its answer under the pre-rewrite scope.
  if (stamp && scopeAfterRead === pairScope) {
    // Dated at the diff's start so an input edited while it ran is too recent to store.
    settledBranchChangeListCache.set(
      key,
      { ...stamp, capturedAtMs: readStartedAtMs },
      { entries, attributePaths },
      readGeneration
    )
  }
  return entries
}
