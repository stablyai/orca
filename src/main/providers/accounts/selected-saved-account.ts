// The saved account an agent's next launch on this host uses, where one home holds several (agy's):
// a wait for one saved account's usage limit lifts once another is selected.

import { AGY_HOST_SELECTION } from '../../antigravity/agy-account-selection'

/** Undefined for an agent whose accounts are told apart by their homes, or none selected. */
export function selectedSavedAccount(agent: string): string | undefined {
  return agent === 'antigravity' ? AGY_HOST_SELECTION.current() || undefined : undefined
}

/** Called once each new selection is committed; returns the unsubscribe. */
export function onSavedAccountSelected(listener: () => void): () => void {
  return AGY_HOST_SELECTION.onChanged((committed) => {
    if (committed()) {
      listener()
    }
  })
}
