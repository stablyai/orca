import type {
  GitBranchChangeEntry,
  GitBranchCompareResult,
  GitBranchCompareSummary
} from '../../../src/shared/types'
import { t } from '@/i18n/mobile-i18n'

export type MobileGitBranchChangeEntry = GitBranchChangeEntry
export type MobileGitBranchCompareSummary = GitBranchCompareSummary
export type MobileGitBranchCompareResult = GitBranchCompareResult

export type MobileBranchCompareSection<
  TEntry extends MobileGitBranchChangeEntry = MobileGitBranchChangeEntry
> = {
  title: string
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
    title: t('mobileBranchCompare.committed'),
    data: [...entries].sort(compareBranchEntries)
  }
}

export function formatMobileBranchCompareSummary(
  summary: MobileGitBranchCompareSummary
): string | null {
  if (summary.status !== 'ready') {
    return summary.errorMessage ?? null
  }
  const parts = [
    t(
      summary.changedFiles === 1
        ? 'mobileBranchCompare.changedFileCountFile'
        : 'mobileBranchCompare.changedFileCountFiles',
      {
        changedFileCount: summary.changedFiles
      }
    )
  ]
  if (summary.commitsAhead !== undefined) {
    parts.push(
      t(
        summary.commitsAhead === 1
          ? 'mobileBranchCompare.commitCountCommit'
          : 'mobileBranchCompare.commitCountCommits',
        {
          commitCount: summary.commitsAhead
        }
      )
    )
  }
  parts.push(t('mobileBranchCompare.vs', { baseRef: summary.baseRef }))
  return parts.join(' - ')
}

export function canOpenMobileBranchCompareDiff(summary: MobileGitBranchCompareSummary): boolean {
  return summary.status === 'ready' && Boolean(summary.headOid && summary.mergeBase)
}
