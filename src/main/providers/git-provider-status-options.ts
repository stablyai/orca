// Kept separate so the central cross-provider contract stays within its enforced size limit.
export type GitProviderStatusOptions = {
  includeIgnored?: boolean
  bypassEffectiveUpstreamNegativeCache?: boolean
  reuseLineStats?: boolean
  signal?: AbortSignal
}
