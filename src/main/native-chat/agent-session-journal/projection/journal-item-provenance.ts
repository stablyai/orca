import { journalItemEchoRestatement, type JournalItemEcho } from './journal-item-echo'
// ownerFence preserves creation provenance; executionOwner tracks later runs resuming reusable children.

import type { JournalReducerState } from './journal-reducer'

export function journalItemExecutionFence(
  state: Pick<JournalReducerState, 'itemFences' | 'itemExecutionOwners'>,
  itemId: string
): number | undefined {
  return state.itemExecutionOwners.get(itemId) ?? state.itemFences.get(itemId)
}

export function journalItemProvenance(
  state: Pick<JournalReducerState, 'itemFences' | 'itemExecutionOwners' | 'itemEchoes'>,
  itemId: string
): JournalItemEcho & { ownerFence?: number; executionOwner?: number } {
  return {
    ...journalItemEchoRestatement(state.itemEchoes, itemId),
    ownerFence: state.itemFences.get(itemId),
    executionOwner: state.itemExecutionOwners.get(itemId)
  }
}

/** Revisions retain the creator's owner; new items use stated provenance or the writer fence. */
export function journalItemOwnerFence(
  state: Pick<JournalReducerState, 'itemFences' | 'items'>,
  resolvedItemId: string,
  write: { fence: number; ownerFence?: number }
): number {
  const kept = state.items.has(resolvedItemId) ? state.itemFences.get(resolvedItemId) : undefined
  return kept ?? write.ownerFence ?? write.fence
}
