import { mobileTasksChromeStyles } from './mobile-tasks-chrome-styles'
import { mobileTasksListStyles } from './mobile-tasks-list-styles'
import { mobileTasksProjectPickerStyles } from './mobile-tasks-project-picker-styles'
import { mobileTasksDetailStyles } from './mobile-tasks-detail-styles'
import { mobileTasksWorkspaceReviewStyles } from './mobile-tasks-workspace-review-styles'
import { mobileTasksDiffCommentStyles } from './mobile-tasks-diff-comment-styles'
import { mobileTasksComposerActionStyles } from './mobile-tasks-composer-action-styles'

export const styles = {
  ...mobileTasksChromeStyles,
  ...mobileTasksListStyles,
  ...mobileTasksProjectPickerStyles,
  ...mobileTasksDetailStyles,
  ...mobileTasksWorkspaceReviewStyles,
  ...mobileTasksDiffCommentStyles,
  ...mobileTasksComposerActionStyles
}

export function getPrSignalToneStyle(tone: 'neutral' | 'success' | 'warning' | 'danger') {
  if (tone === 'success') {
    return styles.prSignalSuccess
  }
  if (tone === 'warning') {
    return styles.prSignalWarning
  }
  if (tone === 'danger') {
    return styles.prSignalDanger
  }
  return null
}

export function getGitLabPipelineStatusStyle(status: string) {
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
