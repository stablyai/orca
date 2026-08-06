// Pure helpers for the branch-card conflict Abort control. Kept free of React so
// the busy-label rule (abort-in-flight only) is unit-testable.

/** True while git.abortMerge / git.abortRebase is the active serial action. */
export function isMobileConflictAborting(
  busyAction: string | null,
  conflictOperation: string | null
): boolean {
  if (conflictOperation !== 'merge' && conflictOperation !== 'rebase') {
    return false
  }
  return busyAction === `abort-${conflictOperation}`
}

/** Label for the Abort control — never says "Aborting…" for unrelated busy work. */
export function mobileConflictAbortLabel(conflictOperation: string, aborting: boolean): string {
  return aborting ? 'Aborting…' : `Abort ${conflictOperation}`
}
