import type { UISlice } from '@/store/slices/ui/ui-slice-contract'
import { isPluginPanelTabKey } from '../../../../shared/plugins/frames/plugin-tab-key'

/** Buttons and shortcut handlers share the same canonical page-route eligibility. */
export function shouldShowWorktreeHistoryControls(activeView: UISlice['activeView']): boolean {
  return (
    activeView === 'terminal' ||
    activeView === 'tasks' ||
    activeView === 'automations' ||
    activeView === 'artifacts' ||
    activeView === 'skills' ||
    isPluginPanelTabKey(activeView)
  )
}

/** Back/forward act on the view behind; not while Bot templates is open over it. */
export function canNavigateWorktreeHistory(
  state: Pick<UISlice, 'activeView' | 'activeModal'>
): boolean {
  return (
    state.activeModal !== 'bot-templates' && shouldShowWorktreeHistoryControls(state.activeView)
  )
}
