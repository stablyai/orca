import { journalItemEchoRestatement, type JournalItemEcho } from './journal-item-echo'
// Execution provenance: the generation whose execution produced an item (`JournalItemRow.ownerFence`),
// kept apart from each row's writer fence. The write that creates an item states it; every revision
// keeps it. A reusable child's row (a subagent, a Claude background task) a later run resumes also
// names that run (`JournalItemRow.executionOwner`), which is whose work the item is now.

import type { JournalReducerState } from './journal-reducer'

/** Whose execution the item is now: the run that last stated it executes it, else its creator. */
export function journalItemExecutionFence(
  state: Pick<JournalReducerState, 'itemFences' | 'itemExecutionOwners'>,
  itemId: string
): number | undefined {
  return state.itemExecutionOwners.get(itemId) ?? state.itemFences.get(itemId)
}

/** The item's execution and echo provenance, carried together when history is retained. */
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

/** An existing item keeps its owner whoever revises it: a newer run's start revises the newest saved
 *  turn. Creation states the writer's claim (an observation, carried history), else its fence. */
export function journalItemOwnerFence(
  state: Pick<JournalReducerState, 'itemFences' | 'items'>,
  resolvedItemId: string,
  write: { fence: number; ownerFence?: number }
): number {
  const kept = state.items.has(resolvedItemId) ? state.itemFences.get(resolvedItemId) : undefined
  return kept ?? write.ownerFence ?? write.fence
}
