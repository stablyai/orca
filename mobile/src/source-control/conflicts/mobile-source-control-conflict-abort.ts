import { translate } from '../../i18n/mobile-i18n'

export function isMobileConflictAborting(
  busyAction: string | null,
  conflictOperation: string | null
): boolean {
  if (conflictOperation === null || conflictOperation === 'unknown') {
    return false
  }
  return busyAction === `abort-${conflictOperation}`
}

export function mobileConflictAbortLabel(conflictOperation: string, aborting: boolean): string {
  if (aborting) {
    return translate('sourceControl.conflictAbort.aborting', 'Aborting…')
  }
  switch (conflictOperation) {
    case 'merge':
      return translate('sourceControl.conflictAbort.abortMerge', 'Abort merge')
    case 'rebase':
      return translate('sourceControl.conflictAbort.abortRebase', 'Abort rebase')
    case 'cherry-pick':
      return translate('sourceControl.conflictAbort.abortCherryPick', 'Abort cherry-pick')
    case 'revert':
      return translate('sourceControl.conflictAbort.abortRevert', 'Abort revert')
    default:
      return translate('sourceControl.conflictAbort.abortOperation', 'Abort {{operation}}', {
        operation: conflictOperation
      })
  }
}
