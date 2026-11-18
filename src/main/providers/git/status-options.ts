export type GitProviderStatusOptions = {
  admissionTier?: 'interactive' | 'status' | 'background'
  includeIgnored?: boolean
  includeLineStats?: boolean
  bypassEffectiveUpstreamNegativeCache?: boolean
  reuseLineStats?: boolean
  /** Merge-base OID to measure the branch line total against; omit to skip the work. */
  branchLineTotalMergeBase?: string
  signal?: AbortSignal
}

export type GitSubmoduleStatusOptions = {
  /** Only the submodule's own working-tree changes: no committed-range rows, no line stats. */
  workingTreeOnly?: boolean
}
