// The journal members the event sink reaches besides a plain append, for tests whose journal double
// has no write queue: a read and a resolved append each run as they are issued, as on an idle queue.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalItemAppendOptions } from '../agent-session-journal/journal-store-contracts'

type AppendingDouble = {
  appendItem: (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions
  ) => Promise<unknown>
}

export function withJournalQueueMembers<T extends AppendingDouble>(
  journal: T
): T & {
  readInOrder: <R>(read: () => R) => Promise<R>
  appendResolvedItem: (
    resolve: () => { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null,
    options: JournalItemAppendOptions
  ) => Promise<unknown>
} {
  return Object.assign(journal, {
    readInOrder: async <R>(read: () => R): Promise<R> => read(),
    appendResolvedItem: async (
      resolve: () => { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null,
      options: JournalItemAppendOptions
    ): Promise<unknown> => {
      const resolved = resolve()
      // Read at call time, so a test that swaps the double's append later is still the one called.
      return resolved === null
        ? null
        : journal.appendItem(resolved.identity, resolved.body, options)
    }
  })
}
