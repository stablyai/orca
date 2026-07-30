import type { WorkspaceStatusDefinition } from '../../../src/shared/types'
import { t } from '@/i18n/mobile-i18n'

export const DEFAULT_MOBILE_WORKSPACE_STATUS_ID = 'in-progress'

export const DEFAULT_MOBILE_WORKSPACE_STATUSES = [
  { id: 'completed', label: t('m.EleEi2Q'), color: 'conductor-done', icon: 'conductor-done' },
  { id: 'in-review', label: t('m.mg8ozqs'), color: 'conductor-review', icon: 'conductor-review' },
  {
    id: DEFAULT_MOBILE_WORKSPACE_STATUS_ID,
    label: t('m.hWeTdOM'),
    color: 'conductor-progress',
    icon: 'conductor-progress'
  },
  { id: 'todo', label: t('m.zWwi3-o'), color: 'neutral', icon: 'circle' }
] as const satisfies readonly WorkspaceStatusDefinition[]

export function coerceMobileWorkspaceStatuses(
  statuses: readonly WorkspaceStatusDefinition[]
): readonly WorkspaceStatusDefinition[] {
  return statuses.length > 0 ? statuses : DEFAULT_MOBILE_WORKSPACE_STATUSES
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
