import type { WorkspaceStatusDefinition } from '../../../src/shared/types'
import { t } from '@/i18n/mobile-i18n'

export const DEFAULT_MOBILE_WORKSPACE_STATUS_ID = 'in-progress'

export function getDefaultMobileWorkspaceStatuses(): readonly WorkspaceStatusDefinition[] {
  return [
    {
      id: 'completed',
      label: t('mobileWorkspaceStatuses.done'),
      color: 'conductor-done',
      icon: 'conductor-done'
    },
    {
      id: 'in-review',
      label: t('mobileWorkspaceStatuses.review'),
      color: 'conductor-review',
      icon: 'conductor-review'
    },
    {
      id: DEFAULT_MOBILE_WORKSPACE_STATUS_ID,
      label: t('mobileWorkspaceStatuses.progress'),
      color: 'conductor-progress',
      icon: 'conductor-progress'
    },
    {
      id: 'todo',
      label: t('mobileWorkspaceStatuses.todo'),
      color: 'neutral',
      icon: 'circle'
    }
  ]
}

export function coerceMobileWorkspaceStatuses(
  statuses: readonly WorkspaceStatusDefinition[]
): readonly WorkspaceStatusDefinition[] {
  return statuses.length > 0 ? statuses : getDefaultMobileWorkspaceStatuses()
}

export function getMobileWorkspaceStatus(
  worktree: { workspaceStatus?: string | null },
  statuses: readonly WorkspaceStatusDefinition[]
): string {
  const availableStatuses = coerceMobileWorkspaceStatuses(statuses)
  if (
    worktree.workspaceStatus &&
    availableStatuses.some((status) => status.id === worktree.workspaceStatus)
  ) {
    return worktree.workspaceStatus
  }
  if (availableStatuses.some((status) => status.id === DEFAULT_MOBILE_WORKSPACE_STATUS_ID)) {
    return DEFAULT_MOBILE_WORKSPACE_STATUS_ID
  }
  return availableStatuses[0]?.id ?? DEFAULT_MOBILE_WORKSPACE_STATUS_ID
}

export function getMobileWorkspaceStatusGroupKey(status: string): string {
  return `workspace-status:${encodeURIComponent(status)}`
}
