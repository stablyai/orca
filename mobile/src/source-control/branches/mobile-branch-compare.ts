import { compareFileNames } from '../../../../src/shared/file-listing/file-name-sort'
import type { Translate } from '../../i18n/mobile-i18n'
import type {
  MobileGitBranchChangeEntry,
  MobileGitBranchCompareSummary
} from './git-compare-reply-schema'

export type MobileBranchCompareSection<
  TEntry extends MobileGitBranchChangeEntry = MobileGitBranchChangeEntry
> = {
  title: string
  data: TEntry[]
}

export function buildMobileBranchCompareSection<TEntry extends MobileGitBranchChangeEntry>(
  entries: readonly TEntry[],
  t: Translate
): MobileBranchCompareSection<TEntry> | null {
  if (entries.length === 0) {
    return null
  }
  const data = [...entries]
  data.sort((a, b) => compareFileNames(a.path, b.path))
  return {
    title: t('sourceControl.branchCompare.sectionTitle', 'Committed on Branch'),
    data
  }
}

export function canOpenMobileBranchCompareDiff(summary: MobileGitBranchCompareSummary): boolean {
  return summary.status === 'ready' && Boolean(summary.headOid && summary.mergeBase)
}
