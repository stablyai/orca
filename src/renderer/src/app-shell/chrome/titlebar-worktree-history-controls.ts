import type { UISlice } from '@/store/slices/ui/ui-slice-contract'

export function shouldShowWorktreeHistoryControls(activeView: UISlice['activeView']): boolean {
  return (
    activeView === 'terminal' ||
    activeView === 'tasks' ||
    activeView === 'automations' ||
    activeView === 'artifacts' ||
    activeView === 'skills'
  )
}

/** Back/forward act on the view behind; not while Bot templates or the Needs you inbox is open over it. */
export function canNavigateWorktreeHistory(
  state: Pick<UISlice, 'activeView' | 'activeModal'>
): boolean {
  return (
    state.activeModal !== 'bot-templates' &&
    state.activeModal !== 'bots-needs-you' &&
    shouldShowWorktreeHistoryControls(state.activeView)
  )
}
