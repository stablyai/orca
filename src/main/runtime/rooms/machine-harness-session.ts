import { randomUUID } from 'node:crypto'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { isNoiseMessage } from '../../../shared/native-chat-noise'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  activityFromMessages,
  turnUserMessage,
  type RoomHarnessLifecycleEvent
} from './harness-lifecycle'
import type { RoomMachineHarnessBinding } from './harness-adapter-types'

export function structuredRoomHost() {
  const current = getStructuredAgentSessionHost()
  if (!current) {
    throw new Error('structured_agent_session_unsupported')
  }
  return current
}

export function readStructuredRoomState(sessionId: string): StructuredAgentSessionState {
  const result = structuredRoomHost().history({ sessionId, direction: 'tail', limit: 200 })
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'tail-page',
    page: result.page
  })
}

export function roomStructuredLifecycle(
  state: StructuredAgentSessionState,
  replay = false
): RoomHarnessLifecycleEvent | null {
  const lifecycleItem = latestStructuredRoomLifecycleItem(state)
  const lifecycle = lifecycleItem?.body
  if (!lifecycleItem || !lifecycle || lifecycle.kind !== 'status' || !lifecycle.turnLifecycle) {
    return null
  }
  const turnId = lifecycle.turnLifecycle.turnId
  const lifecycleItems = state.items.filter(
    (item) => item.body.kind === 'status' && item.body.turnLifecycle
  )
  const previousLifecycle = lifecycleItems.at(-2)
  const active = lifecycle.turnLifecycle.state === 'running'
  const turnItems = state.items.filter((item) => item.turn?.turnId === turnId)
  // Older journals predate explicit turn ownership.
  const scopedItems = state.items.filter((item) =>
    turnItems.length > 0
      ? item.turn?.turnId === turnId
      : item.sequence > (previousLifecycle?.sequence ?? -1) &&
        (active || item.sequence <= lifecycleItem.sequence)
  )
  const projected = projectStructuredItemsToNativeChat(scopedItems)
  const rootId = scopedItems.find(
    (item) => item.turn?.root && item.body.kind === 'message' && item.body.role === 'user'
  )?.itemId
  const rootUserIndex = projected.findIndex(
    (message) =>
      message.role === 'user' &&
      (turnItems.length === 0 || message.id === rootId) &&
      !message.blocks.some((block) => block.type === 'tool-result') &&
      !isNoiseMessage(message)
  )
  const turnMessages =
    turnItems.length > 0 ? projected : rootUserIndex === -1 ? [] : projected.slice(rootUserIndex)
  const observedUserMessage = turnUserMessage(turnMessages)
  const userMessage = observedUserMessage ? { ...observedUserMessage, id: turnId } : undefined
  const messages =
    turnItems.length > 0
      ? projected.filter((_, index) => index !== rootUserIndex)
      : turnMessages.slice(1)
  const outcome = lifecycle.turnLifecycle.outcome
  const prompt = scopedItems.findLast(
    (item) =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
  const permission =
    prompt?.body.kind === 'approval'
      ? {
          id: prompt.itemId,
          itemId: prompt.itemId,
          revision: prompt.revision,
          title: prompt.body.title,
          ...(prompt.body.detail ? { detail: prompt.body.detail } : {}),
          options: prompt.body.options.map((option) => ({
            ...option,
            kind: option.id.startsWith('reject') ? ('reject' as const) : ('allow-once' as const)
          }))
        }
      : undefined
  const input =
    prompt?.body.kind === 'question'
      ? {
          id: prompt.itemId,
          itemId: prompt.itemId,
          revision: prompt.revision,
          questionGroup: Boolean(prompt.body.questions),
          questions: prompt.body.questions?.map((question) => ({
            ...question,
            header: question.header ?? '',
            allowOther: Boolean(question.freeTextQuestionId)
          })) ?? [
            {
              id: prompt.body.freeTextQuestionId ?? prompt.itemId,
              header: prompt.body.question,
              question: prompt.body.question,
              options: prompt.body.options,
              allowOther: Boolean(prompt.body.freeTextQuestionId)
            }
          ]
        }
      : undefined
  return {
    type: active
      ? 'activity'
      : outcome === 'failed'
        ? 'failed'
        : outcome === 'interrupted'
          ? 'interrupted'
          : 'final',
    source: 'transcript',
    turnId,
    timestamp: active
      ? (scopedItems.at(-1)?.observedAt ?? lifecycleItem.observedAt)
      : (lifecycleItem.updatedAt ?? lifecycleItem.observedAt),
    messages,
    ...(userMessage ? { userMessage } : {}),
    ...(replay ? { replay: true as const } : {}),
    ...(active
      ? {
          activity: messages.some((message) => message.role !== 'user' && message.role !== 'system')
            ? activityFromMessages(messages)
            : { kind: 'thinking' as const }
        }
      : {}),
    ...(permission ? { permission } : {}),
    ...(input ? { input } : {})
  }
}

export function latestStructuredRoomLifecycleItem(state: StructuredAgentSessionState) {
  return (
    state.items.findLast((item) => item.body.kind === 'status' && item.body.turnLifecycle) ?? null
  )
}

export function structuredRoomMutationEnvelope(
  sessionId: string,
  method: string,
  fields: Record<string, unknown>
): AgentSessionMutationEnvelope {
  return {
    sessionId,
    clientOperationId: structuredRoomOperationId(),
    expectedRuntimeFence: readStructuredRoomState(sessionId).fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId, fields })
  }
}

export function structuredRoomOperationId(): string {
  return createStructuredAgentSessionOperationId(randomUUID)
}

export function structuredRoomCaller(value: RoomMachineHarnessBinding) {
  return { callerKey: `trusted-local:room:${value.worktreeId}` }
}

export function structuredRoomHolderId(value: RoomMachineHarnessBinding): string {
  return `room:${value.worktreeId}:${value.conversationId}`
}

export function createRoomMachineBinding(
  worktreeId: string,
  conversationId: string,
  disposition: 'created' | 'adopted',
  sourceSessionId?: string
): RoomMachineHarnessBinding {
  return {
    transport: 'machine',
    worktreeId,
    conversationId,
    providerSession: {
      key: 'session_id',
      id: conversationId,
      transport: 'machine',
      ...(sourceSessionId ? { sourceSessionId } : {})
    },
    disposition
  }
}
