import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnLifecycle,
  type AgentJournalTurnLifecycleState
} from '../../shared/agent-session-journal-types'
import {
  journalLifecycleItemMutation,
  type JournalLifecycleIdentityMutationInput
} from '../native-chat/agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import type { CodexTurnOrdinals } from './codex-structured-item-translation'
import type { CodexStructuredItemStreams } from './codex-structured-item-streams'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { codexCommandOutlivesTurn } from './codex-command-lifecycle'
import {
  codexTurnLifecycleBody,
  codexTurnLifecycleIdentity
} from './codex-structured-journal-translation-turns'
import { appendCodexLifecycleMutations } from './codex-structured-journal-sink'
import { codexActiveItemBody, interruptedCodexItemBody } from './codex-unfinished-item-body'
import type { CodexRowAttribution } from './codex-subagent-linkage'
import type { CodexActiveJournalItem } from './codex-structured-journal-contracts'

export type CodexPendingJournalPrompt = {
  threadId: string
  turnId: string | null
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function settleCodexJournalSession(input: {
  event: Extract<CodexStructuredSessionEvent, { type: 'ended' }>
  sink: StructuredAgentSessionEventSink
  streams: CodexStructuredItemStreams
  activeItems: ReadonlyMap<string, CodexActiveJournalItem>
  pendingPrompts: ReadonlyMap<string, CodexPendingJournalPrompt>
  currentTurnIds: ReadonlyMap<string, ReadonlySet<string>>
  primaryThreadId: string | null
  ordinals: CodexTurnOrdinals
  /** Null for command-owned turns, which the host settles. */
  settledTurnLifecycle: (threadId: string, turnId: string) => AgentJournalTurnLifecycle | null
  attributionFor: CodexRowAttribution
  now?: () => number
}): StructuredAgentSessionSinkAdmission {
  // Rows from every thread settle in this one batch, so each names its own producer.
  const mutations: JournalLifecycleIdentityMutationInput[] = []
  const turnOrdinalsToForget: { threadId: string; turnId: string }[] = []
  for (const active of input.activeItems.values()) {
    const body = interruptedCodexItemBody(codexActiveItemBody(active, input.streams), {
      at: input.event.observedAt ?? input.now?.() ?? Date.now(),
      call: 'interrupted'
    })
    if (body) {
      mutations.push(settledRow(input.attributionFor, active, body))
    }
  }
  for (const prompt of input.pendingPrompts.values()) {
    const body = cancelledJournalPromptBody(prompt.body)
    if (body) {
      mutations.push(settledRow(input.attributionFor, prompt, body))
    }
  }
  for (const [threadId, turnIds] of input.currentTurnIds) {
    if (input.primaryThreadId !== threadId) {
      continue
    }
    for (const turnId of turnIds) {
      const turnLifecycle = input.settledTurnLifecycle(threadId, turnId)
      if (turnLifecycle) {
        mutations.push({
          kind: 'item',
          identity: codexTurnLifecycleIdentity(input.event.sessionId, turnId),
          body: codexTurnLifecycleBody(turnLifecycle),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      }
      turnOrdinalsToForget.push({ threadId, turnId })
    }
  }
  const admission = appendCodexLifecycleMutations(
    input.sink,
    exitSettlementId(input.event),
    mutations
  )
  if (!admission.accepted) {
    return admission
  }
  for (const { threadId, turnId } of turnOrdinalsToForget) {
    input.ordinals.forgetTurn(threadId, turnId)
  }
  return ADMITTED
}

export function settleCodexJournalTurn(input: {
  sessionId: string
  threadId: string
  turnId: string
  /** Only primary-thread turns own lifecycle rows. */
  turnLifecycle: AgentJournalTurnLifecycle | null
  /** Host end time, also applied to unfinished items. */
  completedAt: number
  /** Unfinished calls inherit this turn-end state on every thread. */
  turnEnd: Extract<AgentJournalTurnLifecycleState, 'completed' | 'interrupted'>
  sink: StructuredAgentSessionEventSink
  streams: CodexStructuredItemStreams
  activeItems: Map<string, CodexActiveJournalItem>
  pendingPrompts?: Map<string, CodexPendingJournalPrompt>
  clearPromptTurn?: (threadId: string, turnId: string) => void
  attributionFor: CodexRowAttribution
  /** Settle the carried conversation command in the same batch. */
  commandEnd?: readonly JournalLifecycleIdentityMutationInput[]
}): StructuredAgentSessionSinkAdmission {
  const mutations: JournalLifecycleIdentityMutationInput[] = []
  const activeItemsToForget: { key: string; threadId: string; itemId: string }[] = []
  const pendingPromptsToForget: string[] = []
  const pendingPrompts = input.pendingPrompts ?? new Map<string, CodexPendingJournalPrompt>()
  for (const [key, active] of input.activeItems) {
    if (active.threadId !== input.threadId || active.turnId !== input.turnId) {
      continue
    }
    if (codexCommandOutlivesTurn(active.item)) {
      continue
    }
    const body = interruptedCodexItemBody(codexActiveItemBody(active, input.streams), {
      at: input.completedAt,
      call: input.turnEnd
    })
    if (body) {
      mutations.push(settledRow(input.attributionFor, active, body))
    }
    activeItemsToForget.push({ key, threadId: active.threadId, itemId: active.item.id })
  }
  for (const [key, prompt] of pendingPrompts) {
    if (prompt.threadId !== input.threadId || prompt.turnId !== input.turnId) {
      continue
    }
    const body = cancelledJournalPromptBody(prompt.body)
    if (body) {
      mutations.push(settledRow(input.attributionFor, prompt, body))
    }
    pendingPromptsToForget.push(key)
  }
  // Preserve the terminal row so the turn's duration remains available.
  if (input.turnLifecycle) {
    mutations.push({
      kind: 'item',
      identity: codexTurnLifecycleIdentity(input.sessionId, input.turnId),
      body: codexTurnLifecycleBody(input.turnLifecycle),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  mutations.push(...(input.commandEnd ?? []))
  const admission = appendCodexLifecycleMutations(
    input.sink,
    `turn-completed:${input.sessionId}:${input.threadId}:${input.turnId}`,
    mutations
  )
  if (!admission.accepted) {
    return admission
  }
  for (const active of activeItemsToForget) {
    input.streams.forget(active.threadId, active.itemId)
    input.activeItems.delete(active.key)
  }
  for (const key of pendingPromptsToForget) {
    pendingPrompts.delete(key)
  }
  input.clearPromptTurn?.(input.threadId, input.turnId)
  return ADMITTED
}

/** Include attribution because settlement may be the row's first write. */
function settledRow(
  attributionFor: CodexRowAttribution,
  row: { threadId: string; turnId: string | null; identity: AgentJournalItemIdentity },
  body: AgentJournalItemBody
): JournalLifecycleIdentityMutationInput {
  return journalLifecycleItemMutation(attributionFor(row.threadId, row.turnId), row.identity, body)
}

function exitSettlementId(event: Extract<CodexStructuredSessionEvent, { type: 'ended' }>): string {
  const fence = 'fence' in event ? event.fence : 0
  const generation = 'acquisitionGeneration' in event ? event.acquisitionGeneration : 'legacy'
  return `provider-exit:${event.sessionId}:${fence}:${generation}`
}
