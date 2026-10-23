// The journal members the event sink reaches besides a plain append, for tests whose journal double
// has no write queue: a read, a resolved append and a run of steps each run as they are issued, as
// on an idle queue.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalStep } from '../agent-session-journal/journal-step-writer'
import type {
  JournalItemAppendOptions,
  JournalLifecycleBatchInput
} from '../agent-session-journal/journal-store-contracts'

type AppendingDouble = {
  appendItem: (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions
  ) => Promise<unknown>
  appendLifecycleBatch?: (input: JournalLifecycleBatchInput) => Promise<unknown>
}

export function withJournalQueueMembers<T extends AppendingDouble>(
  journal: T
): T & {
  readInOrder: <R>(read: () => R) => Promise<R>
  appendResolvedItem: (
    resolve: () => { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null,
    options: JournalItemAppendOptions
  ) => Promise<unknown>
  appendSteps: (steps: readonly JournalStep[]) => Promise<boolean[]>
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
    },
    // A settlement lands through the double's own batch append, as an unresolved one does.
    appendSteps: async (steps: readonly JournalStep[]): Promise<boolean[]> => {
      const wrote: boolean[] = []
      for (const step of steps) {
        if (step.kind === 'item') {
          const resolved = step.resolve()
          if (resolved !== null) {
            await journal.appendItem(resolved.identity, resolved.body, step.options)
          }
          wrote.push(resolved !== null)
          continue
        }
        const { resolve, ...batch } = step.batch
        const mutations = resolve()
        if (mutations.length > 0) {
          await journal.appendLifecycleBatch?.({ ...batch, mutations })
        }
        wrote.push(mutations.length > 0)
      }
      return wrote
    }
  })
}
