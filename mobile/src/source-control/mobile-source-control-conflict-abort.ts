export function isMobileConflictAborting(
  busyAction: string | null,
  conflictOperation: string | null
): boolean {
  if (conflictOperation !== 'merge' && conflictOperation !== 'rebase') {
    return false
  }
  return busyAction === `abort-${conflictOperation}`
}

export function mobileConflictAbortLabel(conflictOperation: string, aborting: boolean): string {
  return aborting ? 'Aborting…' : `Abort ${conflictOperation}`
}
