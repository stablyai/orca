// Run journal-double steps immediately, as on an idle write queue.

import type { AgentJournalItemBody } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalStep } from '../../../agent-session-journal/writing/journal-step-writer'
import type { JournalStepsResult } from '../../../agent-session-journal/writing/journal-writer-step'
import { journalSqlFailure } from '../../../agent-session-journal/journal-sql-failure'
import type {
  JournalItemAppendOptions,
  JournalLifecycleBatchInput
} from '../../../agent-session-journal/journal-store-contracts'

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
  appendSteps: (
    steps: readonly JournalStep[],
    beforeRun?: () => boolean
  ) => Promise<JournalStepsResult>
} {
  return Object.assign(journal, {
    readInOrder: async <R>(read: () => R): Promise<R> => read(),
    appendResolvedItem: async (
      resolve: () => { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null,
      options: JournalItemAppendOptions
    ): Promise<unknown> => {
      const resolved = resolve()
      // Resolve append at call time so later spy replacements take effect.
      return resolved === null
        ? null
        : journal.appendItem(resolved.identity, resolved.body, options)
    },
    appendSteps: async (
      steps: readonly JournalStep[],
      beforeRun?: () => boolean
    ): Promise<JournalStepsResult> => {
      const result: JournalStepsResult = { outcomes: [] }
      if (beforeRun?.() === false) {
        return { outcomes: steps.map(() => ({ kind: 'dropped' as const })) }
      }
      for (const step of steps) {
        try {
          if (step.kind === 'command') {
            throw new Error('journal command steps require a real journal')
          }
          if (step.kind === 'item') {
            const resolved = step.resolve()
            if (resolved !== null) {
              await journal.appendItem(resolved.identity, resolved.body, step.options)
            }
            result.outcomes.push(
              resolved === null ? { kind: 'dropped' } : { kind: 'committed', wrote: true }
            )
            continue
          }
          const { resolve, ...batch } = step.batch
          const mutations = resolve()
          if (mutations.length > 0) {
            await journal.appendLifecycleBatch?.({ ...batch, mutations })
          }
          result.outcomes.push({ kind: 'committed', wrote: mutations.length > 0 })
        } catch (error) {
          result.failure = journalSqlFailure(error)
          break
        }
      }
      return result
    }
  })
}
