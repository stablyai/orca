import type { UISlice } from '@/store/slices/ui/ui-slice-contract'

export function shouldShowWorktreeHistoryControls(activeView: UISlice['activeView']): boolean {
  return (
    activeView === 'terminal' ||
    activeView === 'tasks' ||
    activeView === 'automations' ||
    activeView === 'artifacts' ||
    activeView === 'skills' ||
    activeView === 'community'
  )
}
