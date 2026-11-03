import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalEncodedOutcome } from './journal-persistence-plan'
import type { JournalReducerState } from './journal-reducer'

type ReadView = {
  aliases: Map<string, string | undefined>
  items: Map<AgentJournalRenderItem, AgentJournalRenderItem>
  submissions: Map<AgentJournalSubmission, AgentJournalSubmission>
}
const active = new WeakMap<JournalReducerState, Set<ReadView>>()

/** Retain concurrent point changes only; stream commits never clone accumulated history. */
export function captureJournalReadView(state: JournalReducerState, snapshot: AgentJournalSnapshot) {
  const view: ReadView = { aliases: new Map(), items: new Map(), submissions: new Map() }
  const readers = active.get(state) ?? new Set<ReadView>()
  readers.add(view)
  active.set(state, readers)
  return {
    snapshot: (): AgentJournalSnapshot =>
      view.items.size === 0 && view.submissions.size === 0
        ? snapshot
        : {
            ...snapshot,
            items: snapshot.items.map((item) => view.items.get(item) ?? item),
            submissions: snapshot.submissions.map((entry) => view.submissions.get(entry) ?? entry)
          },
    canonical: (id: string): string =>
      (view.aliases.has(id) ? view.aliases.get(id) : state.aliases.get(id)) ?? id,
    close: (): void => {
      readers.delete(view)
      if (readers.size === 0) {
        active.delete(state)
      }
    }
  }
}

export function retainJournalReadViews(
  state: JournalReducerState,
  values: readonly JournalEncodedOutcome[]
): void {
  const readers = active.get(state)
  if (!readers) {
    return
  }
  for (const value of values) {
    if (value.field !== 'aliases' && value.field !== 'items' && value.field !== 'submissions') {
      continue
    }
    const id: unknown = JSON.parse(value.key)
    if (typeof id !== 'string') {
      throw new Error('invalid encoded journal public key')
    }
    for (const view of readers) {
      if (value.field === 'aliases') {
        if (!view.aliases.has(id)) {
          view.aliases.set(id, state.aliases.get(id))
        }
      } else if (value.field === 'items') {
        preserve(view.items, state.items.get(id))
      } else {
        preserve(view.submissions, state.submissions.get(id))
      }
    }
  }
}
function preserve<T>(previous: Map<T, T>, value: T | undefined): void {
  if (value !== undefined && !previous.has(value)) {
    previous.set(value, structuredClone(value))
  }
}
