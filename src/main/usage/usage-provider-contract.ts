import type { UsageSourceCacheRef } from './usage-source-cache-file'

/** Provider-specific records preserve per-turn/per-event billing and different cache-input semantics; only the scan envelope is shared, including plugins. */

export type UsageProviderId =
  | 'claude'
  | 'codex'
  | 'devin'
  | 'opencode'
  | 'muse'
  | `plugin:${string}`

/** Unlike UsageWorktreeRef, scan attribution also needs repoId. */
export type UsageScanWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

/** Only report projections cross back; sourceCache stays on the scan host. */
export type UsageScanResult<TSession, TDaily> = {
  sessions: readonly TSession[]
  dailyAggregates: readonly TDaily[]
}

export type UsageProvider<TSession, TDaily> = {
  readonly id: UsageProviderId
  readonly label: string
  /** Bumped when the persisted projection changes shape; older caches are discarded. */
  readonly schemaVersion: number
  scan(
    worktrees: UsageScanWorktreeRef[],
    sourceCache: UsageSourceCacheRef
  ): Promise<UsageScanResult<TSession, TDaily>>
}
