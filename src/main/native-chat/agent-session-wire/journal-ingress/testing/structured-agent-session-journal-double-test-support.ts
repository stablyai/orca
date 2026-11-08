// Run journal-double steps immediately, as on an idle write queue.

import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalStep } from '../../../agent-session-journal/writing/journal-step-writer'
import type { JournalStepsResult } from '../../../agent-session-journal/writing/journal-writer-step'
import { journalSqlFailure } from '../../../agent-session-journal/journal-sql-failure'
import { resolveJournalTimelineItem } from '../../../agent-session-journal/writing/journal-timeline-resolution'
import { journalTimelineItemsView } from '../../../agent-session-journal/writing/journal-timeline-view'
import { resolveProviderTimelineSettlement } from '../../../agent-session-timeline/provider-timeline-writer-resolution'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import type {
  JournalItemAppendOptions,
  JournalLifecycleBatchInput
} from '../../../agent-session-journal/journal-store-contracts'

type AppendingDouble = {
  item?: AgentSessionJournal['item']
  visitItems?: AgentSessionJournal['visitItems']
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
      const item = (itemId: string) => journal.item?.(itemId) ?? null
      const view = journalTimelineItemsView(item, () => {
        const items: AgentJournalRenderItem[] = []
        journal.visitItems?.((itemId) => {
          const held = item(itemId)
          if (held) {
            items.push(held)
          }
        })
        return items
      })
      if (beforeRun?.() === false) {
        return { outcomes: steps.map(() => ({ kind: 'dropped' as const })) }
      }
      for (const step of steps) {
        try {
          if (step.kind === 'command') {
            if (step.step.kind === 'resolved-item') {
              const command = step.step
              const resolved = resolveJournalTimelineItem(
                view,
                command.resolution,
                command.options.turnScope,
                command.reservedBytes
              )
              if (resolved.kind === 'dropped') {
                result.outcomes.push(resolved)
              } else {
                await journal.appendItem(resolved.item.identity, resolved.item.body, {
                  ...command.options,
                  turnScope: resolved.item.turnScope ?? command.options.turnScope
                })
                result.outcomes.push({ kind: 'committed', wrote: true })
              }
              continue
            }
            if (
              step.step.kind === 'settlement' &&
              step.step.resolution.kind !== 'history-catch-up'
            ) {
              const { settlementId, fence, ownerFence, recovered } = step.step
              const mutations = resolveProviderTimelineSettlement(view, step.step.resolution)
              if (mutations.length > 0) {
                await journal.appendLifecycleBatch?.({
                  settlementId,
                  fence,
                  ...(ownerFence !== undefined ? { ownerFence } : {}),
                  ...(recovered ? { recovered } : {}),
                  mutations
                })
              }
              result.outcomes.push({ kind: 'committed', wrote: mutations.length > 0 })
              continue
            }
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
