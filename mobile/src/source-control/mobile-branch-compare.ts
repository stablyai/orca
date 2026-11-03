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

export function canOpenMobileBranchCompareDiff(summary: MobileGitBranchCompareSummary): boolean {
  return summary.status === 'ready' && Boolean(summary.headOid && summary.mergeBase)
}
