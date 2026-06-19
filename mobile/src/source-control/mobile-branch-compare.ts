import type {
  GitBranchChangeEntry,
  GitBranchCompareResult,
  GitBranchCompareSummary
} from '../../../src/shared/types'

export type MobileGitBranchChangeEntry = GitBranchChangeEntry
export type MobileGitBranchCompareSummary = GitBranchCompareSummary
export type MobileGitBranchCompareResult = GitBranchCompareResult

export type MobileBranchCompareSection<
  TEntry extends MobileGitBranchChangeEntry = MobileGitBranchChangeEntry
> = {
  title: 'Committed on Branch'
  data: TEntry[]
}

function compareBranchEntries(
  a: MobileGitBranchChangeEntry,
  b: MobileGitBranchChangeEntry
): number {
  return a.path.localeCompare(b.path, undefined, { numeric: true })
}

export function buildMobileBranchCompareSection<TEntry extends MobileGitBranchChangeEntry>(
  entries: readonly TEntry[]
): MobileBranchCompareSection<TEntry> | null {
  if (entries.length === 0) {
    return null
  }
  return {
    title: 'Committed on Branch',
    data: [...entries].sort(compareBranchEntries)
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
