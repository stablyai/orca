import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  agentSessionCurrentContextRows,
  isAgentSessionContextClear
} from '../../../shared/agent-session-context-clear'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { deriveJournalAsyncQuestions } from '../../../shared/native-chat-async-question-facts'
import { nativeChatAsyncQuestionKey } from '../../../shared/native-chat-pending-async-questions'
import type { StructuredAgentSessionCurrentWorkJournal } from './structured-agent-session-current-work'

const projections = new WeakMap<
  StructuredAgentSessionCurrentWorkJournal,
  {
    epoch: string
    sequence: number
    items: AgentJournalRenderItem[]
  }
>()

/** Async asks survive turn end; only delivered input or a cleared context retires them. */
export function pendingJournalAsyncQuestionItems(
  journal: StructuredAgentSessionCurrentWorkJournal
): AgentJournalRenderItem[] {
  const cursor = journal.cursor()
  const prior = projections.get(journal)
  if (prior?.epoch === cursor.epoch && prior.sequence === cursor.sequence) {
    return prior.items
  }
  const candidates: AgentJournalRenderItem[] = []
  journal.visitItems((id, _sequence, body) => {
    if (
      (body.kind === 'message' &&
        (body.role === 'user' ||
          body.blocks.some((block) => block.type === 'text' && !!block.asyncQuestions?.length))) ||
      isAgentSessionContextClear(body)
    ) {
      const item = journal.item(id)
      if (item) {
        candidates.push(item)
      }
    }
  })
  candidates.sort(compareAgentJournalItems)
  const context = agentSessionCurrentContextRows(candidates)
  const pending = new Set(
    // A late rejection can move an old send past the clear; keep its original delivery outcome.
    deriveJournalAsyncQuestions(context.items, journal.submissions()).map((q) => q.key)
  )
  const items = context.items.flatMap((item): AgentJournalRenderItem[] => {
    if (item.body.kind !== 'message' || item.body.role !== 'assistant') {
      return []
    }
    const blocks = item.body.blocks.flatMap((block) => {
      if (block.type !== 'text' || !block.asyncQuestions) {
        return []
      }
      const questions = block.asyncQuestions.filter((_q, index) =>
        pending.has(nativeChatAsyncQuestionKey(item.itemId, index))
      )
      return questions.length ? [{ ...block, asyncQuestions: questions }] : []
    })
    return blocks.length ? [{ ...item, body: { ...item.body, blocks } }] : []
  })
  const stable =
    prior?.epoch === cursor.epoch && JSON.stringify(prior.items) === JSON.stringify(items)
      ? prior.items
      : items
  projections.set(journal, { ...cursor, items: stable })
  return stable
}
