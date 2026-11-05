import { finishJournalStepsAsync } from './journal-reconstruction-steps'
import { journalInputOrder, setJournalInputOrder } from './journal-input-order'
import type { JournalReducerState } from './journal-reducer'
import type { JournalEntryChange } from './journal-transition-collections'
import { JournalDraft } from './journal-reducer-draft'

/** Fold onto a draft of `state`; the live state changes only when `adopt` runs after COMMIT. */
export function isolateJournalTransition<T>(
  state: JournalReducerState,
  fold: (draft: JournalReducerState) => T
): {
  state: JournalReducerState
  result: T
  changes: (reset?: boolean) => JournalEntryChange[]
  changesSteps: (reset?: boolean) => Generator<void, JournalEntryChange[]>
  /** A `JSON.stringify` replacer giving each draft value as it stands, untracked. */
  untracked: (key: string, value: unknown) => unknown
  adopt: () => JournalReducerState
  adoptPrivate: () => Promise<JournalReducerState>
  tracked: () => number
  input: <V>(value: V) => V
  trackedDerived: () => number
} {
  const draft = new JournalDraft()
  const candidate = draft.wrap(state, () => undefined, '')
  // Register canonical maps before the facade can reach them through an isolated query.
  void candidate.inputEntries
  void candidate.inputCards
  const order = draft.wrap(journalInputOrder(state), () => undefined, '@inputOrder')
  setJournalInputOrder(candidate, order)
  const result = fold(candidate)
  return {
    state: candidate,
    input: (value) => draft.wrap(value, () => undefined, 'input'),
    result,
    changes: (reset) =>
      draft.changes(reset).filter((entry) => !entry.path.startsWith('@inputOrder')),
    changesSteps: (reset) => draft.changesSteps(reset),
    untracked: (_key, value) => draft.untracked(value),
    adopt: () => {
      const adopted = draft.adopt({ state: candidate, order })
      setJournalInputOrder(adopted.state, adopted.order)
      return adopted.state
    },
    adoptPrivate: async () => {
      const adopted = await finishJournalStepsAsync(draft.adoptSteps({ state: candidate, order }))
      setJournalInputOrder(adopted.state, adopted.order)
      return adopted.state
    },
    trackedDerived: () => draft.derivedNodes,
    tracked: () => draft.nodes
  }
}
