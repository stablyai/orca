import type { PickerOption } from '../components/PickerModal'
import type { MobileGroupMode, MobileSortMode } from './workspace-view-settings'
import { t } from '@/i18n/mobile-i18n'

export function getWorkspaceSortOptions(): PickerOption<MobileSortMode>[] {
  return [
    // Why: desktop and persisted state keep the `smart` key, while mobile shows the product label.
    {
      value: 'smart',
      label: t('workspaceListPickerOptions.agent'),
      subtitle: t('workspaceListPickerOptions.agents')
    },
    {
      value: 'name',
      label: t('workspaceListPickerOptions.name'),
      subtitle: t('workspaceListPickerOptions.alphabetical')
    },
    {
      value: 'recent',
      label: t('workspaceListPickerOptions.recent'),
      subtitle: t('workspaceListPickerOptions.most')
    },
    {
      value: 'repo',
      label: t('workspaceListPickerOptions.repo'),
      subtitle: t('workspaceListPickerOptions.repository')
    },
    {
      value: 'manual',
      label: t('workspaceListPickerOptions.manual'),
      subtitle: t('workspaceListPickerOptions.server')
    }
  ]
}

export function getWorkspaceGroupOptions(): PickerOption<MobileGroupMode>[] {
  return [
    { value: 'none', label: t('workspaceListPickerOptions.no') },
    { value: 'workspaceStatus', label: t('workspaceListPickerOptions.status') },
    { value: 'repo', label: t('task.repository') },
    { value: 'prStatus', label: t('workspaceListPickerOptions.pr') }
  ]
}
