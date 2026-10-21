import type {
  MobileGitBranchChangeEntry,
  MobileGitBranchCompareReply,
  MobileGitBranchCompareSummary
} from './git-compare-reply-schema'

// The shapes mobile reads off the compare replies are the reply schemas' outputs, not the desktop
// aggregates: a member with no reader in mobile/ is stripped rather than re-declared here.
export type { MobileGitBranchChangeEntry, MobileGitBranchCompareSummary }
export type MobileGitBranchCompareResult = MobileGitBranchCompareReply

export type MobileBranchCompareSection<
  TEntry extends MobileGitBranchChangeEntry = MobileGitBranchChangeEntry
> = {
  title: 'Committed on Branch'
  data: TEntry[]
}

export function buildMobileBranchCompareSection<TEntry extends MobileGitBranchChangeEntry>(
  entries: readonly TEntry[]
): MobileBranchCompareSection<TEntry> | null {
  if (entries.length === 0) {
    return null
  }
  const data = [...entries]
  if (data.length > 1) {
    const collator = new Intl.Collator(undefined, { numeric: true })
    data.sort((a, b) => collator.compare(a.path, b.path))
  }
  return {
    title: 'Committed on Branch',
    data
  }
}

export function formatMobileBranchCompareSummary(
  summary: MobileGitBranchCompareSummary
): string | null {
  if (summary.status !== 'ready') {
    return summary.errorMessage ?? null
  }
  const parts = [`${summary.changedFiles} ${summary.changedFiles === 1 ? 'file' : 'files'}`]
  if (summary.commitsAhead !== undefined) {
    parts.push(`${summary.commitsAhead} ${summary.commitsAhead === 1 ? 'commit' : 'commits'}`)
  }
  parts.push(`vs ${summary.baseRef}`)
  return parts.join(' - ')
}

export function canOpenMobileBranchCompareDiff(summary: MobileGitBranchCompareSummary): boolean {
  return summary.status === 'ready' && Boolean(summary.headOid && summary.mergeBase)
}
