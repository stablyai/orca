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
    title: t('m.jrzi7yY'),
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
    t(summary.changedFiles === 1 ? 'm.SM7vigo' : 'm.Dwq_r1o', {
      value0: summary.changedFiles
    })
  ]
  if (summary.commitsAhead !== undefined) {
    parts.push(
      t(summary.commitsAhead === 1 ? 'm.mLbULQw' : 'm.TWTFkY0', {
        value0: summary.commitsAhead
      })
    )
  }
  parts.push(t('m.t2Awy1s', { value0: summary.baseRef }))
  return parts.join(' - ')
}

export function canOpenMobileBranchCompareDiff(summary: MobileGitBranchCompareSummary): boolean {
  return summary.status === 'ready' && Boolean(summary.headOid && summary.mergeBase)
}
