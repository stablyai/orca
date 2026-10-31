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
import {
  journalLifecycleItemMutation,
  type JournalLifecycleIdentityMutationInput
} from '../native-chat/agent-session-journal/journal-lifecycle-mutation'
import { isHistoricalProviderTimelineItem } from '../native-chat/agent-session-timeline/provider-timeline-history'
import { isProviderTimelineTurnInNamespace } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionHistoryJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  HISTORY_CATCH_UP_MAX_BYTES,
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
import { acpHistoryBoundary } from './acp-history-boundary'

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
      const { kind } = matchAcpHistoryTurns(
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
      const boundaryBody = acpHistoryBoundary()
      const desired = new Map<
        string,
        {
          mutation: JournalLifecycleIdentityMutationInput
          saved: AgentJournalRenderItem | null
          bytes: number
        }
      >()
      let retainedBytes = 0
      const compose = (mutation: JournalLifecycleIdentityMutationInput) => {
        check()
        const key = agentJournalItemKey(mutation.identity)
        if ((baseline.canonical.get(key) ?? key) !== key) {
          throw new Error('unowned-history-target')
        }
        const previous = desired.get(key)
        // Occurrences are complete snapshots; only the body replaces first creation metadata.
        const final =
          previous?.mutation.kind === 'item' && mutation.kind === 'item'
            ? { ...previous.mutation, body: mutation.body }
            : mutation
        const bytes = Buffer.byteLength(JSON.stringify(final), 'utf8')
        retainedBytes += bytes - (previous?.bytes ?? 0)
        if (retainedBytes > HISTORY_CATCH_UP_MAX_BYTES) {
          throw new Error('too-large')
        }
        desired.set(key, { mutation: final, saved: previous?.saved ?? read(key), bytes })
      }
      let divided = false
      for (const { source, items } of candidates) {
        check()
        const coverage = kind.get(source.turn)
        const dividerIdentity = {
          provider: 'legacy',
          agent: input.agent,
          sessionId: input.sessionId,
          recordId: continuedOutsideRecordId(source.turn)
        } as const
        const dividerKey = agentJournalItemKey(dividerIdentity)
        const savedDivider = read(dividerKey)
        if (savedDivider) {
          compose(
            boundaryBody
              ? journalLifecycleItemMutation(
                  { ...savedDivider, turnScope: AGENT_JOURNAL_THREAD_SCOPE },
                  dividerIdentity,
                  boundaryBody
                )
              : { kind: 'tombstone', identity: dividerIdentity }
          )
        }
        if (coverage === 'native' || coverage === 'adopted') {
          continue
        }
        for (const mutation of items) {
          check()
          const key = agentJournalItemKey(mutation.identity)
          const held = read(key)
          if (held && !isHistoricalProviderTimelineItem(held, read)) {
            throw new Error('unowned-history-target')
          }
          if (!held && coverage !== 'imported' && !divided && baseline.retained) {
            if (boundaryBody && !savedDivider) {
              compose(
                journalLifecycleItemMutation(
                  { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
                  dividerIdentity,
                  boundaryBody
                )
              )
            }
            divided = true
          }
          compose(
            held
              ? { ...mutation, turnScope: held.turnScope ?? mutation.turnScope, linkage: undefined }
              : mutation
          )
        }
        await yieldTurn()
      }
      for (const [key, { mutation, saved }] of desired) {
        check()
        if (mutation.kind === 'tombstone') {
          if (saved) {
            batch.expectItem(key, { canonicalItemId: key, revision: saved.revision })
            batch.push(mutation)
            written.push(key)
          }
        } else if (!saved) {
          batch.push(mutation)
          written.push(key)
        } else if (JSON.stringify(saved.body) !== JSON.stringify(mutation.body)) {
          batch.revise(mutation, { canonicalItemId: key, revision: saved.revision })
          written.push(key)
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
