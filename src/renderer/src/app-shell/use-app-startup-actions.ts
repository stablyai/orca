// Keep one stable action projection so unrelated store publications do not restart boot subscriptions.

import { useAppStore } from '../store'
import { selectStartupActions } from './startup-actions-selector'

export function useStartupActions() {
  return useAppStore(selectStartupActions)
}
