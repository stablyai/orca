import type { MobileGitBranchChangeEntry } from './mobile-branch-compare'

export function formatMobileBranchEntryMeta(entry: MobileGitBranchChangeEntry): string | null {
  const stats =
    entry.added !== undefined || entry.removed !== undefined
      ? `+${entry.added ?? 0} -${entry.removed ?? 0}`
      : null
  if (entry.oldPath) {
    return stats ? `from ${entry.oldPath}; ${stats}` : `from ${entry.oldPath}`
  }
  return stats
}
