import type { PickerOption } from '../components/PickerModal'
import type { MobileGroupMode, MobileSortMode } from './workspace-view-settings'
import { t } from '@/i18n/mobile-i18n'

export const WORKSPACE_SORT_OPTIONS: PickerOption<MobileSortMode>[] = [
  // Why: desktop and persisted state keep the `smart` key, while mobile shows the product label.
  {
    value: 'smart',
    label: t('m.6gEQgs0'),
    subtitle: t('m.RcmL46Y')
  },
  { value: 'name', label: t('m.tQqkyxI'), subtitle: t('m.BaGIgrE') },
  { value: 'recent', label: t('m.2xJ96AA'), subtitle: t('m.egkm8qI') },
  { value: 'repo', label: t('m.v5H1mJY'), subtitle: t('m.yH1bPxU') },
  { value: 'manual', label: t('m.FyGSYV4'), subtitle: t('m.y1TvQWs') }
]

export const WORKSPACE_GROUP_OPTIONS: PickerOption<MobileGroupMode>[] = [
  { value: 'none', label: t('m.Iq3a5so') },
  { value: 'workspaceStatus', label: t('m.oBZu0_c') },
  { value: 'repo', label: t('m.BX2Np3Y') },
  { value: 'prStatus', label: t('m.1Bc_S64') }
]
