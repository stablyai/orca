import { themedStyles } from '../theme/themed-styles'
import { mobileTasksChromeStylesSheet } from './screen/mobile-tasks-chrome-styles'
import { mobileTasksListStylesSheet } from './task-list/mobile-tasks-list-styles'
import { mobileTasksProjectPickerStylesSheet } from './project-board/mobile-tasks-project-picker-styles'
import { mobileTasksDetailStylesSheet } from './item-detail/mobile-tasks-detail-styles'
import { mobileTasksWorkspaceReviewStylesSheet } from './workspace-creation/mobile-tasks-workspace-review-styles'
import { mobileTasksDiffCommentStylesSheet } from './item-detail/mobile-tasks-diff-comment-styles'
import { mobileTasksComposerActionStylesSheet } from './workspace-creation/mobile-tasks-composer-action-styles'

export const stylesSheet = themedStyles((_colors, scheme) => ({
  ...mobileTasksChromeStylesSheet.resolve(scheme),
  ...mobileTasksListStylesSheet.resolve(scheme),
  ...mobileTasksProjectPickerStylesSheet.resolve(scheme),
  ...mobileTasksDetailStylesSheet.resolve(scheme),
  ...mobileTasksWorkspaceReviewStylesSheet.resolve(scheme),
  ...mobileTasksDiffCommentStylesSheet.resolve(scheme),
  ...mobileTasksComposerActionStylesSheet.resolve(scheme)
}))

export type MobileTasksStyles = ReturnType<typeof stylesSheet.resolve>

export function getGitLabPipelineStatusStyle(styles: MobileTasksStyles, status: string) {
  switch (status) {
    case 'success':
      return styles.pipelineStatusSuccess
    case 'failed':
      return styles.pipelineStatusDanger
    case 'manual':
      return styles.pipelineStatusWarning
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return styles.pipelineStatusActive
    case 'canceled':
    case 'skipped':
    default:
      return null
  }
}
