import { translate } from '../i18n/mobile-i18n'

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
  if (aborting) {
    return translate('sourceControl.conflictAbort.aborting', 'Aborting…')
  }
  switch (conflictOperation) {
    case 'merge':
      return translate('sourceControl.conflictAbort.abortMerge', 'Abort merge')
    case 'rebase':
      return translate('sourceControl.conflictAbort.abortRebase', 'Abort rebase')
    default:
      return translate('sourceControl.conflictAbort.abortOperation', 'Abort {{operation}}', {
        operation: conflictOperation
      })
  }
}
