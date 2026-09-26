import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnLifecycle
} from '../../shared/agent-session-journal-types'
import {
  journalLifecycleItemMutation,
  type JournalLifecycleMutationInput
} from '../native-chat/agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import {
  codexJournalItem,
  codexStreamingJournalItem,
  type CodexThreadItem,
  type CodexTurnOrdinals
} from './codex-structured-item-translation'
import type { CodexStructuredItemStreams } from './codex-structured-item-streams'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { codexCommandOutlivesTurn } from './codex-command-lifecycle'
import {
  codexTurnLifecycleBody,
  codexTurnLifecycleIdentity
} from './codex-structured-journal-translation-turns'
import { appendCodexLifecycleMutations } from './codex-structured-journal-sink'
import type { CodexRowAttribution } from './codex-subagent-linkage'

export type CodexActiveJournalItem = {
  threadId: string
  turnId: string | null
  identity: AgentJournalItemIdentity
  item: CodexThreadItem
}

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
  /** Terminal lifecycle for a turn the provider left running when it ended; null for a turn a
   *  conversation command claimed, whose record the host settles. */
  settledTurnLifecycle: (threadId: string, turnId: string) => AgentJournalTurnLifecycle | null
  attributionFor: CodexRowAttribution
}): StructuredAgentSessionSinkAdmission {
  // Rows from every thread settle in this one batch, so each names its own producer.
  const mutations: JournalLifecycleMutationInput[] = []
  const turnOrdinalsToForget: { threadId: string; turnId: string }[] = []
  for (const active of input.activeItems.values()) {
    const streamed = input.streams.snapshot(active.threadId, active.item.id)
    const translated = streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item)
    const body = interruptedBody(translated.body)
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
  /** Null off the primary thread: only the primary turn owns a lifecycle row. */
  turnLifecycle: AgentJournalTurnLifecycle | null
  sink: StructuredAgentSessionEventSink
  streams: CodexStructuredItemStreams
  activeItems: Map<string, CodexActiveJournalItem>
  pendingPrompts?: Map<string, CodexPendingJournalPrompt>
  clearPromptTurn?: (threadId: string, turnId: string) => void
  attributionFor: CodexRowAttribution
}): StructuredAgentSessionSinkAdmission {
  const mutations: JournalLifecycleMutationInput[] = []
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
    const streamed = input.streams.snapshot(active.threadId, active.item.id)
    const translated = streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item)
    const body = interruptedBody(translated.body)
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
  // Revised, never tombstoned: the terminal row keeps the turn's duration durable.
  if (input.turnLifecycle) {
    mutations.push({
      kind: 'item',
      identity: codexTurnLifecycleIdentity(input.sessionId, input.turnId),
      body: codexTurnLifecycleBody(input.turnLifecycle),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
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

/** Settle streamed items whose terminal notification was rejected as oversized. */
export function settleCodexOversizedNotification(input: {
  sessionId: string
  threadId: string
  method: string
  sink: StructuredAgentSessionEventSink
  streams: CodexStructuredItemStreams
  activeItems: Map<string, CodexActiveJournalItem>
  attributionFor: CodexRowAttribution
}): StructuredAgentSessionSinkAdmission {
  const itemType = oversizedStreamItemType(input.method)
  if (!itemType) {
    return ADMITTED
  }
  const mutations: JournalLifecycleMutationInput[] = []
  const activeItemsToForget: { key: string; threadId: string; itemId: string }[] = []
  for (const [key, active] of input.activeItems) {
    if (active.threadId !== input.threadId || active.item.type !== itemType) {
      continue
    }
    const streamed = input.streams.snapshot(active.threadId, active.item.id)
    const translated = streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item)
    const body = interruptedBody(translated.body)
    if (body) {
      mutations.push(settledRow(input.attributionFor, active, body))
    }
    activeItemsToForget.push({ key, threadId: active.threadId, itemId: active.item.id })
  }
  if (mutations.length === 0) {
    return ADMITTED
  }
  const admission = appendCodexLifecycleMutations(
    input.sink,
    `oversized-notification:${input.sessionId}:${input.threadId}:${input.method}`,
    mutations
  )
  if (!admission.accepted) {
    return admission
  }
  for (const active of activeItemsToForget) {
    input.streams.forget(active.threadId, active.itemId)
    input.activeItems.delete(active.key)
  }
  return ADMITTED
}

function oversizedStreamItemType(method: string): CodexThreadItem['type'] | null {
  if (method === 'item/agentMessage/delta') {
    return 'agentMessage'
  }
  if (method === 'item/plan/delta') {
    return 'plan'
  }
  if (
    method === 'command/exec/outputDelta' ||
    method === 'process/outputDelta' ||
    method === 'item/commandExecution/outputDelta' ||
    method === 'item/commandExecution/terminalInteraction'
  ) {
    return 'commandExecution'
  }
  if (method === 'item/fileChange/outputDelta' || method === 'item/fileChange/patchUpdated') {
    return 'fileChange'
  }
  if (
    method === 'item/reasoning/summaryTextDelta' ||
    method === 'item/reasoning/summaryPartAdded' ||
    method === 'item/reasoning/textDelta'
  ) {
    return 'reasoning'
  }
  return null
}

/** A settled item or prompt, naming its producer: the settlement can be the row's first write. */
function settledRow(
  attributionFor: CodexRowAttribution,
  row: { threadId: string; turnId: string | null; identity: AgentJournalItemIdentity },
  body: AgentJournalItemBody
): JournalLifecycleMutationInput {
  return journalLifecycleItemMutation(attributionFor(row.threadId, row.turnId), row.identity, body)
}

function interruptedBody(body: AgentJournalItemBody | null): AgentJournalItemBody | null {
  if (!body) {
    return null
  }
  if (body.kind === 'tool-call') {
    return { ...body, state: 'failed' }
  }
  if (body.kind === 'message') {
    return body
  }
  return body.kind === 'diff'
    ? { kind: 'status', text: 'File changes were interrupted before completion.' }
    : body
}

function exitSettlementId(event: Extract<CodexStructuredSessionEvent, { type: 'ended' }>): string {
  const fence = 'fence' in event ? event.fence : 0
  const generation = 'acquisitionGeneration' in event ? event.acquisitionGeneration : 'legacy'
  return `provider-exit:${event.sessionId}:${fence}:${generation}`
}
