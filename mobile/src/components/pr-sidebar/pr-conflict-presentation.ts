import type { PRInfo } from '../../../../src/shared/types'

// Pure presentation logic for the PR sidebar's conflicting-files section. No
// React/native imports so it is unit-testable under the node Vitest config (KTD5).
// Ports the LOGIC of the desktop ConflictingFilesSection / MergeConflictNotice,
// not their components.

export type ConflictDisplay = {
  // The conflicting file paths (may be empty when the host has detected a
  // conflict but the file list is not yet available).
  files: string[]
  commitsBehind: number | null
  baseCommit: string | null
  // True when conflicts exist but no file list is available — desktop shows a
  // fallback notice instead of the file list in this case.
  fileDetailsUnavailable: boolean
}

// Conflicts exist only when the host reports CONFLICTING. Anything else (MERGEABLE
// / UNKNOWN) means the section should not render at all (desktop parity).
export function hasMergeConflicts(pr: Pick<PRInfo, 'mergeable'>): boolean {
  return pr.mergeable === 'CONFLICTING'
}

// Resolve the conflict view-model, or null when there is nothing to show. Returns
// a model both when files are listed AND when conflicts exist without a file list
// (so the section can render the fallback notice, matching desktop).
export function resolveConflictDisplay(
  pr: Pick<PRInfo, 'mergeable' | 'conflictSummary'>
): ConflictDisplay | null {
  if (!hasMergeConflicts(pr)) {
    return null
  }
  const files = pr.conflictSummary?.files ?? []
  return {
    files,
    commitsBehind: pr.conflictSummary?.commitsBehind ?? null,
    baseCommit: pr.conflictSummary?.baseCommit ?? null,
    fileDetailsUnavailable: files.length === 0
  }
}
