import type { JournalReducerState } from './journal-reducer'
import { JournalCancellationTargets } from './journal-cancellation-targets'
import { journalItemExecutionFence } from './journal-item-provenance'
import { readJournalExecutionAlias } from './journal-execution-item'

export function restoreJournalCancellationTargets(state: JournalReducerState): void {
  const targets = new JournalCancellationTargets()
  state.derivedTurnScope.cancellations = targets
  for (const [alias, itemId] of state.aliases) {
    targets.rememberAlias(alias, itemId)
  }
  for (const [alias, itemId] of state.aliases) {
    const binding = readJournalExecutionAlias(alias)
    if (
      binding?.opener &&
      state.items.has(itemId) &&
      journalItemExecutionFence(state, binding.opener) === binding.ownerFence
    ) {
      targets.restoreBinding(itemId, binding.opener)
    }
  }
  for (const item of state.items.values()) {
    targets.restoreOwner(item)
  }
  for (const item of state.items.values()) {
    targets.observeTurn(state, item)
  }
  for (const submission of state.submissions.values()) {
    targets.observeSubmission(state, submission)
  }
}
