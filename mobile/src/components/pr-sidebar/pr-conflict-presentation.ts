import type { PRInfo } from '../../../../src/shared/github/pull-request-types'

// Keep conflict view-model pure and RN-free; follow desktop ConflictingFilesSection/MergeConflictNotice logic.

export type ConflictDisplay = {
  // Host may report conflicts before file list becomes available.
  files: string[]
  commitsBehind: number | null
  baseCommit: string | null
  // Missing-list conflicts need desktop-style fallback notice.
  fileDetailsUnavailable: boolean
  // True when the host reports conflicts but the local merge simulation is clean.
  localMergeClean: boolean
  mergeabilityRefreshCommands: string | null
}

// Render only hosted CONFLICTING; MERGEABLE/UNKNOWN show no section, matching desktop.
export function hasMergeConflicts(pr: Pick<PRInfo, 'mergeable'>): boolean {
  return pr.mergeable === 'CONFLICTING'
}

export function buildMergeabilityRefreshCommands(): string {
  return [
    'git fetch origin',
    'git commit --allow-empty --only -m "chore: refresh PR mergeability"',
    'git push'
  ].join('\n')
}

// Return conflict model for both listed and missing-file cases so fallback still renders; null when no hosted conflict.
export function resolveConflictDisplay(
  pr: Pick<PRInfo, 'mergeable' | 'conflictSummary'>
): ConflictDisplay | null {
  if (!hasMergeConflicts(pr)) {
    return null
  }
  const files = pr.conflictSummary?.files ?? []
  const localMergeClean = pr.conflictSummary?.localMergeState === 'clean'
  return {
    files,
    commitsBehind: pr.conflictSummary?.commitsBehind ?? null,
    baseCommit: pr.conflictSummary?.baseCommit ?? null,
    fileDetailsUnavailable: files.length === 0,
    localMergeClean,
    mergeabilityRefreshCommands: localMergeClean ? buildMergeabilityRefreshCommands() : null
  }
}
