import type { GitRepositoryStatusRequest } from '../../shared/git/status/git-repository-status'

export type GitProviderStatusOptions = GitRepositoryStatusRequest & {
  admissionTier?: 'interactive' | 'status' | 'background'
  includeIgnored?: boolean
  includeLineStats?: boolean
  bypassEffectiveUpstreamNegativeCache?: boolean
  reuseLineStats?: boolean
  /** Merge-base OID to measure the branch line total against; omit to skip the work. */
  branchLineTotalMergeBase?: string
  signal?: AbortSignal
}
