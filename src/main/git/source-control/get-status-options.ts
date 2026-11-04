import type { GitRuntimeOptions } from '../git-runtime-options'

export type GetStatusOptions = GitRuntimeOptions & {
  includeIgnored?: boolean
  includeLineStats?: boolean
  reuseLineStats?: boolean
  /** Attach a fresh owner-side rebase verdict (`rebaseOperation`) read for this call. */
  verifyRebaseOperation?: boolean
  /** Omit to hide the branch chip and skip its ranged diff. */
  branchLineTotalMergeBase?: string
  /** Stop after this many entries and mark didHitLimit; defaults to DEFAULT_GIT_STATUS_LIMIT, 0 disables. */
  limit?: number
  bypassEffectiveUpstreamNegativeCache?: boolean
  /** Hide real symlinks at Orca-shared paths; directory-only ignore rules cannot hide those links. */
  sharedLinkPaths?: readonly string[]
}
