import type { GitRuntimeOptions } from '../git-runtime-options'

export type GetStatusOptions = GitRuntimeOptions & {
  includeIgnored?: boolean
  reuseLineStats?: boolean
  /** Merge-base OID the caller wants the branch line total measured against;
   *  omitted means the chip is hidden, so no ranged diff runs at all. */
  branchLineTotalMergeBase?: string
  /**
   * Max changed-file entries before git is stopped and the result is marked
   * `didHitLimit`. Defaults to DEFAULT_GIT_STATUS_LIMIT; 0 disables the cap.
   */
  limit?: number
  bypassEffectiveUpstreamNegativeCache?: boolean
  /** Paths Orca may have symlinked into this worktree (per-user shared paths
   *  plus `orca.yaml` shared directories). Untracked entries that are one of
   *  these *and* really symlinks are dropped: Git cannot ignore them when the
   *  repo's rule is directory-only (`node_modules/`), but they are Orca's own
   *  artifacts, not user work. */
  sharedLinkPaths?: readonly string[]
}
