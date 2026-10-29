import type {
  StructuredAgentSessionCurrentWork,
  StructuredAgentSessionCurrentWorkJournal
} from './structured-agent-session-current-work'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { CurrentRequestsPayload } from '../../../shared/agent-session-current-requests-wire'
import {
  agentSessionCurrentContextRows,
  latestAgentSessionContextClearSequence
} from '../../../shared/agent-session-context-clear'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { createPendingAskScanner } from '../../../shared/native-chat/input/native-chat-ask'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { hostStatesTurnScopes } from '../../../shared/native-chat-turn-membership'
import { lastRowOfTurn } from '../../../shared/native-chat/transcript/native-chat-cut-turn-notice'

const projections = new WeakMap<
  StructuredAgentSessionCurrentWorkJournal,
  { key: string; payload: CurrentRequestsPayload; json: string }
>()

/** Canonical delivery and turn boundaries are independent of the displayed history window. */
export function structuredAsyncQuestions(
  journal: StructuredAgentSessionCurrentWorkJournal,
  sessionId: string,
  work: StructuredAgentSessionCurrentWork
): CurrentRequestsPayload {
  const cursor = journal.cursor()
  const submissions = journal.submissions().map(work.publishedSubmission)
  const blocking = work.actionablePrompts()
  const key = JSON.stringify([sessionId, cursor, submissions])
  const prior = projections.get(journal)
  if (prior?.key === key && prior.payload.blocking === blocking) {
    return prior.payload
  }
  const all: AgentJournalRenderItem[] = []
  journal.visitItems((id) => {
    const item = journal.item(id)
    if (item) {
      all.push(item)
    }
  })
  all.sort(compareAgentJournalItems)
  const boundary = latestAgentSessionContextClearSequence(all)
  const { items } = agentSessionCurrentContextRows(all, submissions)
  const messages = new Map(
    projectStructuredAgentSessionMessages(items, [], submissions).map((message) => [
      message.id,
      message
    ])
  )
  const undelivered = new Set(
    submissions.flatMap((send) =>
      send.dispatchState === 'accepted'
        ? []
        : [
            agentJournalSubmissionKey(send.clientMessageId),
            ...(send.providerItemId ? [send.providerItemId] : [])
          ]
    )
  )
  const interrupts = new Set<number>()
  const scoped = hostStatesTurnScopes(items)
  items.forEach((item, index) => {
    const turn = readAgentJournalTurn(item.body)
    const verdict =
      turn && isRootAgentJournalItem(item)
        ? agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) })
        : null
    if (verdict === 'cancellation' || verdict === 'interruption') {
      interrupts.add(lastRowOfTurn(items, index, scoped))
    }
  })
  const scan = createPendingAskScanner()
  items.forEach((item, index) => {
    const message = messages.get(item.itemId)
    if (message) {
      scan.append(undelivered.has(message.id) ? { ...message, unsent: true } : message)
    }
    if (interrupts.has(index)) {
      scan.interrupt()
    }
  })
  const payload: CurrentRequestsPayload = {
    blocking,
    asyncQuestions: scan.current().contributors,
    context: { sessionId, boundary: `${cursor.epoch}:${boundary}` }
  }
  const json = JSON.stringify(payload)
  const stable = prior?.json === json ? prior.payload : payload
  projections.set(journal, { key, payload: stable, json })
  return stable
}
