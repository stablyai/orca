export type GitProviderStatusOptions = {
  admissionTier?: 'interactive' | 'status' | 'background'
  includeIgnored?: boolean
  includeLineStats?: boolean
  bypassEffectiveUpstreamNegativeCache?: boolean
  reuseLineStats?: boolean
  /** Attach a fresh owner-side rebase verdict (`rebaseOperation`) read for this call. */
  verifyRebaseOperation?: boolean
  /** Merge-base OID to measure the branch line total against; omit to skip the work. */
  branchLineTotalMergeBase?: string
  signal?: AbortSignal
}
