// Pure helpers for the branch-card conflict Abort/Continue controls. Kept free of
// React so the busy-label rules (matching action in flight only) are unit-testable.

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

/** True while the matching git.continue* call is the active serial action. */
export function isMobileConflictAdvancing(
  busyAction: string | null,
  conflictOperation: string | null
): boolean {
  if (
    conflictOperation !== 'merge' &&
    conflictOperation !== 'rebase' &&
    conflictOperation !== 'cherry-pick'
  ) {
    return false
  }
  return busyAction === `continue-${conflictOperation}`
}

/** Label for the Abort control — never says "Aborting…" for unrelated busy work. */
export function mobileConflictAbortLabel(conflictOperation: string, aborting: boolean): string {
  return aborting ? 'Aborting…' : `Abort ${conflictOperation}`
}

/** Label for the Continue control — never says "Continuing…" for unrelated busy work. */
export function mobileConflictContinueLabel(conflictOperation: string, advancing: boolean): string {
  return advancing ? 'Continuing…' : `Continue ${conflictOperation}`
}
