import { compareFileNames } from '../../../src/shared/file-name-sort'
import { translate } from '../i18n/mobile-i18n'
import type {
  MobileGitBranchChangeEntry,
  MobileGitBranchCompareReply,
  MobileGitBranchCompareSummary
} from './git-compare-reply-schema'

export type { MobileGitBranchChangeEntry, MobileGitBranchCompareSummary }
export type MobileGitBranchCompareResult = MobileGitBranchCompareReply

export type MobileBranchCompareSection<
  TEntry extends MobileGitBranchChangeEntry = MobileGitBranchChangeEntry
> = {
  title: string
  data: TEntry[]
}

export function buildMobileBranchCompareSection<TEntry extends MobileGitBranchChangeEntry>(
  entries: readonly TEntry[]
): MobileBranchCompareSection<TEntry> | null {
  if (entries.length === 0) {
    return null
  }
  const data = [...entries]
  data.sort((a, b) => compareFileNames(a.path, b.path))
  return {
    title: translate('sourceControl.branchCompare.sectionTitle', 'Committed on Branch'),
    data
  }
}

export function formatMobileBranchCompareSummary(
  summary: MobileGitBranchCompareSummary
): string | null {
  if (summary.status !== 'ready') {
    return summary.errorMessage ?? null
  }
  const files = branchCompareFiles(summary.changedFiles)
  if (summary.commitsAhead === undefined) {
    return translate('sourceControl.branchCompare.summary', '{{files}} - vs {{baseRef}}', {
      files,
      baseRef: summary.baseRef
    })
  }
  return translate(
    'sourceControl.branchCompare.summaryWithCommits',
    '{{files}} - {{commits}} - vs {{baseRef}}',
    { files, commits: branchCompareCommits(summary.commitsAhead), baseRef: summary.baseRef }
  )
}

function branchCompareFiles(count: number): string {
  return count === 1
    ? translate('sourceControl.branchCompare.files_one', '{{count}} file', { count })
    : translate('sourceControl.branchCompare.files_other', '{{count}} files', { count })
}

function branchCompareCommits(count: number): string {
  return count === 1
    ? translate('sourceControl.branchCompare.commits_one', '{{count}} commit', { count })
    : translate('sourceControl.branchCompare.commits_other', '{{count}} commits', { count })
}

export function canOpenMobileBranchCompareDiff(summary: MobileGitBranchCompareSummary): boolean {
  return summary.status === 'ready' && Boolean(summary.headOid && summary.mergeBase)
}
