import type { ThemeColors } from '../theme/mobile-theme'
import { createTasksScreenChromeStyles } from './tasks-screen-chrome-styles'
import { createTasksScreenListStyles } from './tasks-screen-list-styles'
import { createTasksScreenDetailStyles } from './tasks-screen-detail-styles'
import { createTasksScreenFormStyles } from './tasks-screen-form-styles'
import { createTasksScreenPanelStyles } from './tasks-screen-panel-styles'
import { createTasksScreenMiscStyles } from './tasks-screen-misc-styles'

export const createTasksScreenStyles = (colors: ThemeColors) => ({
  ...createTasksScreenChromeStyles(colors),
  ...createTasksScreenListStyles(colors),
  ...createTasksScreenDetailStyles(colors),
  ...createTasksScreenFormStyles(colors),
  ...createTasksScreenPanelStyles(colors),
  ...createTasksScreenMiscStyles(colors)
})

export function getPrSignalToneStyle(
  styles: ReturnType<typeof createTasksScreenStyles>,
  tone: 'neutral' | 'success' | 'warning' | 'danger'
) {
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

export function getGitLabPipelineStatusStyle(
  styles: ReturnType<typeof createTasksScreenStyles>,
  status: string
) {
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
