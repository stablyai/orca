// Kept separate so the central cross-provider contract stays within its enforced size limit.
export type GitProviderStatusOptions = {
  includeIgnored?: boolean
  bypassEffectiveUpstreamNegativeCache?: boolean
  reuseLineStats?: boolean
  /** Merge-base OID to measure the branch line total against; omit to skip the work. */
  branchLineTotalMergeBase?: string
  signal?: AbortSignal
}
