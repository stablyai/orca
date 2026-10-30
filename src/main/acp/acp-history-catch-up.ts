import {
  agentJournalItemKey,
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { nativeChatRowRendersContent } from '../../shared/native-chat-row-content'
import { projectNativeChatTranscriptMessages } from '../../shared/native-chat-transcript-projection'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import { usableJournalHistoryOrigin } from '../native-chat/agent-session-journal/journal-history-origin'
import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/journal-lifecycle-mutation'
import { isHistoricalProviderTimelineItem } from '../native-chat/agent-session-timeline/provider-timeline-history'
import { isProviderTimelineTurnInNamespace } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionHistoryJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId,
  createHistoryCatchUpBatch,
  runHistoryCatchUp
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  acpHistoryTurns,
  type AcpIdentifiedHistoryTurn,
  type AcpLoadHistoryFrame
} from './acp-history-replay'
import { translateHistoryTurn, type AcpHistoryScope } from './acp-history-translation'
import { matchAcpHistoryTurns, type AcpHistoryCandidate } from './acp-history-turn-matching'
import { acpAgentName } from './acp-structured-agent-definitions'

export type AcpHistoryCatchUpInput = AcpHistoryScope & {
  frames: readonly AcpLoadHistoryFrame[]
  sink: StructuredAgentSessionEventSink
  assertCurrent: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
}

/** Optional history work owns no sends; one checked runner settlement lands all changed bodies. */
export async function catchUpAcpHistory(input: AcpHistoryCatchUpInput): Promise<void> {
  let candidates: AcpHistoryCandidate[] = []
  await runHistoryCatchUp({
    agentName: acpAgentName(input.agent),
    scope: 'acp-history-catch-up',
    sessionId: input.sessionId,
    sink: input.sink,
    assertCurrent: input.assertCurrent,
    timeoutMs: input.timeoutMs ?? 30_000,
    ...(input.logger ? { logger: input.logger } : {}),
    readView: (history) => journalView(input, history, candidates),
    sameView: (a, b) => a.token === b.token,
    prepare: async ({ journal, view, check, yieldTurn }) => {
      // Derive source keys once without saved facts, then capture before any saved read or yield.
      candidates = acpHistoryTurns(input.frames, input.identity, check)
        .filter((turn): turn is AcpIdentifiedHistoryTurn => turn.turn !== null)
        .map((source) => ({
          source,
          items: translateHistoryTurn(input, source, check)
        }))
      const baseline = view()
      const { natives, kind, matched } = matchAcpHistoryTurns(
        input,
        baseline,
        candidates,
        baseline.importedAt,
        baseline.requests,
        check
      )
      const batch = createHistoryCatchUpBatch()
      // The rows written name the import, so a later open's additions settle under their own id.
      const written: string[] = []
      const read = (key: string) => baseline.items.get(key) ?? null
      let divided = false
      for (const { source, items } of candidates) {
        check()
        const coverage = kind.get(source.turn)
        if (coverage === 'native' || coverage === 'adopted') {
          continue
        }
        for (const mutation of items) {
          check()
          const key = agentJournalItemKey(mutation.identity)
          const canonical = baseline.canonical.get(key) ?? key
          const held = read(canonical)
          if (canonical !== key || (held && !isHistoricalProviderTimelineItem(held, read))) {
            throw new Error('unowned-history-target')
          }
          if (held && JSON.stringify(held.body) === JSON.stringify(mutation.body)) {
            continue
          }
          if (!held && coverage !== 'imported' && !divided && baseline.retained) {
            const divider = journalLifecycleItemMutation(
              { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
              {
                provider: 'legacy',
                agent: input.agent,
                sessionId: input.sessionId,
                recordId: continuedOutsideRecordId(source.turn)
              },
              continuedOutsideNotice(
                natives.length > 0 && ![...matched.values()].includes(natives.length - 1)
              )
            )
            const dividerKey = agentJournalItemKey(divider.identity)
            if (!read(dividerKey)) {
              batch.push(divider)
              written.push(dividerKey)
            }
            divided = true
          }
          if (!held) {
            batch.push(mutation)
            written.push(key)
          } else if (mutation.kind === 'item') {
            // Ordinary revisions retain the creating scope/position and an unstated producer.
            batch.revise(
              { ...mutation, linkage: undefined },
              { canonicalItemId: canonical, revision: held.revision }
            )
          } else {
            throw new Error('unowned-history-target')
          }
        }
        await yieldTurn()
      }
      return batch.size
        ? batch.finish('acp-history-import', [journal.epoch, input.providerSessionId, written])
        : null
    }
  })
}

/** Only dependencies used for coverage, ownership, bodies and boundary policy enter the view. */
function journalView(
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
  const items = new Map(
    all
      .filter((item) => {
        const id = parseAgentJournalItemKey(item.itemId)
        return (
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
    importedAt,
    retained
  ])
  return { items, canonical, requests, importedAt, retained, token }
}
