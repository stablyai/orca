// The renderer boot chain's store subscription, kept apart from the chain itself
// so unrelated store publications reuse one action projection.

import { useAppStore } from '../store'
import { selectStartupActions } from './startup-actions-selector'

export function useStartupActions() {
  return useAppStore(selectStartupActions)
}
