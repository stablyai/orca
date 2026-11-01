import type { ConflictResolution } from '../../../src/shared/source-control-entry-actions'
import { translate, type Translate } from '../i18n/mobile-i18n'

export const MOBILE_COMPLETE_MERGE_ACTION_ID = 'complete-merge'

export function mobileConflictNeedsNewerHostMessage(): string {
  return translate(
    'sourceControl.conflictActions.needsNewerHost',
    'Update Orca on the computer running this workspace to resolve merge conflicts from your phone.'
  )
}

export function mobileConflictResolutionLabel(
  resolution: ConflictResolution,
  t: Translate
): string {
  switch (resolution) {
    case 'mark_resolved':
      return t('sourceControl.conflictActions.markResolved', 'Mark as resolved')
    case 'keep_file':
      return t('sourceControl.conflictActions.keepFile', 'Keep file')
    case 'keep_deletion':
      return t('sourceControl.conflictActions.keepDeletion', 'Keep deletion')
  }
}
