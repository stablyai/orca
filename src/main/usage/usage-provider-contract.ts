/**
 * Seam a usage source implements to be scanned by Orca, including plugin-contributed ones.
 *
 * Deliberately generic over each provider's record types: Claude bills per turn while
 * Codex/OpenCode bill per event, and `cachedInput` is a subset of `input` for the latter but a
 * peer bucket for Claude. A single normalized record would push nullable handling onto every
 * consumer, so only the scan envelope is shared.
 */

export type UsageProviderId = 'claude' | 'codex' | 'opencode' | `plugin:${string}`

/** Scan input. Distinct from `UsageWorktreeRef` in usage-worktree-metadata, which lacks `repoId`. */
export type UsageScanWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

/**
 * `TSourceKey` is the provider's own name for its per-source scan cache (`processedFiles`,
 * `processedDatabases`). It stays a type parameter because those names are persisted on disk.
 */
export type UsageScanResult<TSourceKey extends string, TSource, TSession, TDaily> = Record<
  TSourceKey,
  readonly TSource[]
> & {
  sessions: readonly TSession[]
  dailyAggregates: readonly TDaily[]
}

export type UsageProvider<TSourceKey extends string, TSource, TSession, TDaily> = {
  readonly id: UsageProviderId
  readonly label: string
  /** Bumped when the persisted projection changes shape; older caches are discarded. */
  readonly schemaVersion: number
  scan(
    worktrees: UsageScanWorktreeRef[],
    previous: TSource[]
  ): Promise<UsageScanResult<TSourceKey, TSource, TSession, TDaily>>
}
