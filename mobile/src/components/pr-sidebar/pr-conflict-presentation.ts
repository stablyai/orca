import type { PRInfo } from '../../../../src/shared/github/pull-request-types'

// Pure presentation logic for the PR sidebar's conflicts section. No React/native
// imports so it is unit-testable under the node Vitest config (KTD5). Ports the
// copy of the desktop MergeConflictNotice, not its component.

export type ConflictDisplay = {
  title: string
  body: string
}

// Conflicts exist only when the host reports CONFLICTING. Anything else (MERGEABLE
// / UNKNOWN) means the section should not render at all (desktop parity).
export function hasMergeConflicts(pr: Pick<PRInfo, 'mergeable'>): boolean {
  return pr.mergeable === 'CONFLICTING'
}

// The host only reports that conflicts exist; Git lists the files once the merge
// runs in the worktree, so the copy points there instead of at a file list.
export function resolveConflictDisplay(
  pr: Pick<PRInfo, 'mergeable' | 'baseRefName'>
): ConflictDisplay | null {
  if (!hasMergeConflicts(pr)) {
    return null
  }
  const base = pr.baseRefName
  if (!base) {
    return {
      title: 'GitHub reports conflicts with the base branch',
      body: 'Merge the base branch into this branch to see and resolve the conflicting files.'
    }
  }
  return {
    title: `GitHub reports conflicts with ${base}`,
    body: `Merge ${base} into this branch to see and resolve the conflicting files.`
  }
}
