import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalEncodedOutcome } from './journal-persistence-plan'
import type { JournalReducerState } from './journal-reducer'
import {
  parseAgentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { QueuedMessageRow } from './queued-message-table'

type ReadView = {
  inputChanges: Map<string, AgentJournalSubmission | undefined>
  queue: Map<string, QueuedMessageRow | undefined>
  aliases: Map<string, string | undefined>
  items: Map<AgentJournalRenderItem, AgentJournalRenderItem>
  submissions: Map<AgentJournalSubmission, AgentJournalSubmission>
}
const active = new WeakMap<JournalReducerState, Set<ReadView>>()

/** Retain concurrent point changes only; stream commits never clone accumulated history. */
export function captureJournalReadView(state: JournalReducerState, snapshot: AgentJournalSnapshot) {
  const view: ReadView = {
    inputChanges: new Map(),
    queue: new Map(),
    aliases: new Map(),
    items: new Map(),
    submissions: new Map()
  }
  const readers = active.get(state) ?? new Set<ReadView>()
  readers.add(view)
  active.set(state, readers)
  const currentSnapshot = (): AgentJournalSnapshot =>
    view.items.size === 0 && view.submissions.size === 0
      ? snapshot
      : {
          ...snapshot,
          items: snapshot.items.map((item) => view.items.get(item) ?? item),
          submissions: snapshot.submissions.map((entry) => view.submissions.get(entry) ?? entry)
        }
  return {
    snapshotForItems: (ids: ReadonlySet<string>): AgentJournalSnapshot => {
      const captured = currentSnapshot()
      const selected = new Map(
        captured.submissions
          .filter((input) => ids.has(agentJournalSubmissionKey(input.clientMessageId)))
          .map((input) => [input.clientMessageId, input])
      )
      for (const key of ids) {
        const identity = parseAgentJournalItemKey(key)
        if (identity?.provider !== 'orca' || selected.has(identity.clientMessageId)) {
          continue
        }
        const id = identity.clientMessageId
        const input = view.inputChanges.has(id)
          ? view.inputChanges.get(id)
          : state.submissions.get(id)
        if (input) {
          selected.set(id, view.submissions.get(input) ?? input)
        }
      }
      return {
        ...captured,
        submissions: [...selected.values()].sort(
          (a, b) =>
            a.submittedAt - b.submittedAt || (a.submittedSequence ?? 0) - (b.submittedSequence ?? 0)
        )
      }
    },
    hasSubmission: (id: string) =>
      view.inputChanges.has(id)
        ? view.inputChanges.get(id) !== undefined
        : state.submissions.has(id),
    queueSourceIds: (id: string): readonly string[] => {
      const row = view.queue.has(id) ? view.queue.get(id) : state.queue.cards.get(id)
      return [
        id,
        ...(row?.recovers ? [row.recovers] : []),
        ...(row?.consumedAs ? [row.consumedAs] : [])
      ]
    },
    snapshot: currentSnapshot,
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
    if (
      value.field !== 'aliases' &&
      value.field !== 'items' &&
      value.field !== 'submissions' &&
      value.field !== 'queue.cards'
    ) {
      continue
    }
    const id: unknown = JSON.parse(value.key)
    if (typeof id !== 'string') {
      throw new Error('invalid encoded journal public key')
    }
    for (const view of readers) {
      if (value.field === 'queue.cards') {
        if (!view.queue.has(id)) {
          const prior = state.queue.cards.get(id)
          view.queue.set(id, prior && structuredClone(prior))
        }
      } else if (value.field === 'aliases') {
        if (!view.aliases.has(id)) {
          view.aliases.set(id, state.aliases.get(id))
        }
      } else if (value.field === 'items') {
        preserve(view.items, state.items.get(id))
      } else {
        if (!view.inputChanges.has(id)) {
          const input = state.submissions.get(id)
          view.inputChanges.set(id, input)
        }
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
