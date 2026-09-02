import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { partitionJournalLifecycleMutations } from '../native-chat/agent-session-journal/journal-lifecycle-batch-partition'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  boundJournalStatusText,
  cancelledJournalPromptBody
} from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import {
  codexJournalItem,
  codexStreamingJournalItem,
  type CodexThreadItem,
  type CodexTurnOrdinals
} from './codex-structured-item-translation'
import type { CodexStructuredItemStreams } from './codex-structured-item-streams'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

export type CodexActiveJournalItem = {
  threadId: string
  turnId: string | null
  identity: AgentJournalItemIdentity
  item: CodexThreadItem
}

export type CodexPendingJournalPrompt = {
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
}): StructuredAgentSessionSinkAdmission {
  const mutations: JournalLifecycleMutationInput[] = []
  const turnOrdinalsToForget: { threadId: string; turnId: string }[] = []
  for (const active of input.activeItems.values()) {
    const streamed = input.streams.snapshot(active.threadId, active.item.id)
    const translated = streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item)
    const body = interruptedBody(translated.body)
    if (body) {
      mutations.push({ kind: 'item', identity: active.identity, body })
    }
  }
  for (const prompt of input.pendingPrompts.values()) {
    const body = cancelledJournalPromptBody(prompt.body)
    if (body) {
      mutations.push({
        kind: 'item',
        identity: prompt.identity,
        body
      })
    }
  }
  if (!('cause' in input.event) || input.event.cause === 'unexpected-exit') {
    mutations.push({
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: exitSettlementId(input.event) },
      body: {
        kind: 'status',
        text: boundJournalStatusText(`Provider exited: ${input.event.reason}`)
      }
    })
  }
  for (const [threadId, turnIds] of input.currentTurnIds) {
    if (input.primaryThreadId !== threadId) {
      continue
    }
    for (const turnId of turnIds) {
      mutations.push({
        kind: 'tombstone',
        identity: {
          provider: 'legacy',
          agent: 'codex',
          sessionId: input.event.sessionId,
          recordId: `turn-lifecycle:${turnId}`
        }
      })
      turnOrdinalsToForget.push({ threadId, turnId })
    }
  }
  const admission = appendLifecycleMutations(input.sink, exitSettlementId(input.event), mutations)
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
  sink: StructuredAgentSessionEventSink
  streams: CodexStructuredItemStreams
  activeItems: Map<string, CodexActiveJournalItem>
}): StructuredAgentSessionSinkAdmission {
  const mutations: JournalLifecycleMutationInput[] = []
  const activeItemsToForget: { key: string; threadId: string; itemId: string }[] = []
  for (const [key, active] of input.activeItems) {
    if (active.threadId !== input.threadId || active.turnId !== input.turnId) {
      continue
    }
    const streamed = input.streams.snapshot(active.threadId, active.item.id)
    const translated = streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item)
    const body = interruptedBody(translated.body)
    if (body) {
      mutations.push({ kind: 'item', identity: active.identity, body })
    }
    activeItemsToForget.push({ key, threadId: active.threadId, itemId: active.item.id })
  }
  mutations.push({
    kind: 'tombstone',
    identity: {
      provider: 'legacy',
      agent: 'codex',
      sessionId: input.sessionId,
      recordId: `turn-lifecycle:${input.turnId}`
    }
  })
  const admission = appendLifecycleMutations(
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
      mutations.push({ kind: 'item', identity: active.identity, body })
    }
    activeItemsToForget.push({ key, threadId: active.threadId, itemId: active.item.id })
  }
  if (mutations.length === 0) {
    return ADMITTED
  }
  const admission = appendLifecycleMutations(
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

function appendLifecycleMutations(
  sink: StructuredAgentSessionEventSink,
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[]
): StructuredAgentSessionSinkAdmission {
  const chunks = partitionJournalLifecycleMutations(settlementId, mutations)
  for (const { settlementId: id, mutations: chunk } of chunks) {
    let admission: StructuredAgentSessionSinkAdmission = ADMITTED
    if (sink.tryAppendLifecycleBatch) {
      admission = sink.tryAppendLifecycleBatch(id, chunk, { lifecycle: true })
    } else if (sink.appendLifecycleBatch) {
      admission = sink.appendLifecycleBatch(id, chunk, { lifecycle: true }) ?? ADMITTED
    } else {
      for (const mutation of chunk) {
        if (mutation.kind === 'item') {
          if (sink.tryAppendItem) {
            admission = sink.tryAppendItem(mutation.identity, mutation.body, [], {
              lifecycle: true
            })
            if (!admission.accepted) {
              return admission
            }
          } else {
            sink.appendItem(mutation.identity, mutation.body, [], { lifecycle: true })
          }
        } else {
          if (sink.tryAppendTombstone) {
            admission = sink.tryAppendTombstone(mutation.identity, { lifecycle: true })
            if (!admission.accepted) {
              return admission
            }
          } else {
            sink.appendTombstone(mutation.identity, { lifecycle: true })
          }
        }
      }
    }
    if (!admission.accepted) {
      return admission
    }
    const publishAdmission = sink.tryPublish
      ? sink.tryPublish({ lifecycle: true })
      : (sink.publish({ lifecycle: true }), ADMITTED)
    if (!publishAdmission.accepted) {
      return publishAdmission
    }
  }
  return ADMITTED
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
