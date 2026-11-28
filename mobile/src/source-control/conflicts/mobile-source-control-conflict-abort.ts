import type { Translate } from '../../i18n/mobile-i18n'

export function isMobileConflictAborting(
  busyAction: string | null,
  conflictOperation: string | null
): boolean {
  if (conflictOperation !== 'merge' && conflictOperation !== 'rebase') {
    return false
  }
  return busyAction === `abort-${conflictOperation}`
}

export function mobileConflictAbortLabel(
  conflictOperation: string,
  aborting: boolean,
  t: Translate
): string {
  if (aborting) {
    return t('sourceControl.conflictAbort.aborting', 'Aborting…')
  }
  switch (conflictOperation) {
    case 'merge':
      return t('sourceControl.conflictAbort.abortMerge', 'Abort merge')
    case 'rebase':
      return t('sourceControl.conflictAbort.abortRebase', 'Abort rebase')
    default:
      return t('sourceControl.conflictAbort.abortOperation', 'Abort {{operation}}', {
        operation: conflictOperation
      })
  }
}
