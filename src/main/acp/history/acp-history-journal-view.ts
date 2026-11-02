import {
  agentJournalItemKey,
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { nativeChatRowRendersContent } from '../../../shared/native-chat/transcript/native-chat-row-content'
import { projectNativeChatTranscriptMessages } from '../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { projectStructuredAgentSessionMessages } from '../../../shared/agent-session/view/structured-agent-session-message-projection'
import { usableJournalHistoryOrigin } from '../../native-chat/agent-session-journal/journal-history-origin'

import { isProviderTimelineTurnInNamespace } from '../../native-chat/agent-session-timeline/provider-timeline-identity'

import type { StructuredAgentSessionHistoryJournal } from '../../native-chat/agent-session-wire/structured-agent-session-journal-views'
import { continuedOutsideRecordId } from '../../native-chat/agent-session-wire/structured-agent-session-history-catch-up'

import type { AcpHistoryCandidate } from './acp-history-turn-matching'

import type { AcpHistoryCatchUpInput } from './acp-history-catch-up'

/** Only dependencies used for coverage, ownership, bodies and boundary policy enter the view. */
export function acpHistoryJournalView(
  scope: AcpHistoryCatchUpInput,
  history: StructuredAgentSessionHistoryJournal,
  candidates: readonly AcpHistoryCandidate[]
) {
  const journal = scope.sink.journalItems?.()
  if (!journal) {
    throw new Error('no-history-journal')
  }
  const all: AgentJournalRenderItem[] = []
  history.visitItems((key) => {
    const item = history.item(key)
    if (item) {
      all.push(item)
    }
  })
  const submissions = history.submissions()
  const eligible = submissions.filter(
    (send) => send.handedOverAt !== undefined || send.handoverRecorded !== true
  )
  const eligibleUsers = new Set(
    eligible
      .filter((send) => send.keptAsQueuedMessageId === undefined)
      .map((send) => agentJournalSubmissionKey(send.clientMessageId))
  )
  const retained = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(all, [], submissions)
  ).some(
    (message) =>
      nativeChatRowRendersContent(message.blocks) &&
      (parseAgentJournalItemKey(message.id)?.provider !== 'orca' ||
        (message.role === 'user' && eligibleUsers.has(message.id)))
  )
  const turnKeys = new Set(
    all.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      const id = parseAgentJournalItemKey(item.itemId)
      return turn &&
        id?.provider === 'legacy' &&
        id.agent === scope.agent &&
        id.sessionId === scope.sessionId &&
        isProviderTimelineTurnInNamespace(turn.turnId, scope.providerSessionId)
        ? [item.itemId]
        : []
    })
  )
  const userKeys = new Set(
    all.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turnKeys.has(item.itemId) && turn?.userItemId ? [turn.userItemId] : []
    })
  )
  const dividerKeys = new Set(
    candidates.map(({ source }) =>
      agentJournalItemKey({
        provider: 'legacy',
        agent: scope.agent,
        sessionId: scope.sessionId,
        recordId: continuedOutsideRecordId(source.turn)
      })
    )
  )
  const items = new Map(
    all
      .filter((item) => {
        const id = parseAgentJournalItemKey(item.itemId)
        return (
          (dividerKeys.has(item.itemId) &&
            item.turnScope?.kind === 'thread' &&
            item.body.kind === 'status' &&
            (item.body.presentation === 'continued-outside' ||
              item.body.presentation === 'continued-outside-rewound' ||
              item.body.presentation === 'history-loaded')) ||
          turnKeys.has(item.itemId) ||
          userKeys.has(item.itemId) ||
          (item.turnScope?.kind === 'turn' && turnKeys.has(item.turnScope.turnItemId)) ||
          (id?.provider === 'legacy' &&
            id.agent === scope.agent &&
            id.sessionId === scope.providerSessionId)
        )
      })
      .map((item) => [item.itemId, item])
  )
  const keys = candidates.flatMap(({ source, items }) => [
    ...items.map((item) => agentJournalItemKey(item.identity)),
    agentJournalItemKey({
      provider: 'legacy',
      agent: scope.agent,
      sessionId: scope.sessionId,
      recordId: continuedOutsideRecordId(source.turn)
    })
  ])
  const canonical = new Map(
    [...keys, ...items.keys()].map((key) => [key, journal.canonicalItemId(key)])
  )
  // Aliases are rejected; their target bodies cannot establish exact provider coverage.
  const requests = new Set(eligible.map((send) => `prompt:${send.clientMessageId}`))
  const recoveryItems = new Set(
    candidates.flatMap(({ items }) =>
      items.flatMap((item) =>
        history.recoveryEcho?.(item.identity, item.body)?.kind === 'carrier'
          ? [agentJournalItemKey(item.identity)]
          : []
      )
    )
  )
  const origin = usableJournalHistoryOrigin(history.historyOrigin())
  const handle = origin?.providerHandle
  const importedAt =
    origin &&
    handle?.kind === 'opaque' &&
    handle.agent === scope.agent &&
    handle.value === scope.providerSessionId
      ? origin.importedAt
      : null
  const token = JSON.stringify([
    history.epoch,
    [...items.values()].map((item) => [item.itemId, item.revision]),
    [...canonical],
    [...requests],
    [...recoveryItems],
    importedAt,
    retained
  ])
  return { items, canonical, requests, recoveryItems, importedAt, retained, token }
}
