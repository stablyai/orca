import { randomUUID } from 'node:crypto'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
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
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'

export function machineRoomSubmissionAdmitted(
  state: AgentJournalSubmission['dispatchState']
): boolean {
  if (state === 'unknown') {
    throw new Error('conversation_delivery_uncertain')
  }
  // Admission starts awaiting-turn; only the provider replay confirms room delivery.
  return state === 'pending' || state === 'accepted'
}

export function structuredRoomHost() {
  const current = getStructuredAgentSessionHost()
  if (!current) {
    throw new Error('structured_agent_session_unsupported')
  }
  return current
}

export async function readStructuredRoomState(
  sessionId: string
): Promise<StructuredAgentSessionState> {
  const result = await structuredRoomHost().history({ sessionId, direction: 'tail', limit: 200 })
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'history-page',
    page: result.page
  })
}

export function roomStructuredLifecycle(
  state: StructuredAgentSessionState,
  replay = false
): RoomHarnessLifecycleEvent | null {
  const lifecycleItem = latestStructuredRoomLifecycleItem(state)
  const lifecycle = readAgentJournalTurn(lifecycleItem?.body)
  if (!lifecycleItem || !lifecycle) {
    return null
  }
  const turnId = lifecycle.turnId
  const lifecycleItems = state.items.filter(
    (item) => isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)
  )
  const previousLifecycle = lifecycleItems.at(-2)
  const active = lifecycle.state === 'running'
  const turnItems = state.items.filter((item) =>
    item.turnScope?.kind === 'turn'
      ? item.turnScope.turnItemId === lifecycleItem.itemId
      : item.turn?.turnId === turnId
  )
  const rootId =
    lifecycle.userItemId ??
    state.items.find((item) => item.turn?.root && item.turn.turnId === turnId)?.itemId ??
    agentJournalSubmissionKey(turnId)
  const rootSequence =
    state.items.find((item) => item.itemId === rootId)?.sequence ?? lifecycleItem.sequence
  // Older journals predate explicit turn ownership.
  const scopedItems = state.items.filter(
    (item) =>
      isRootAgentJournalItem(item) &&
      (item.itemId === rootId
        ? true
        : item.turnScope
          ? item.turnScope.kind === 'turn' && item.turnScope.turnItemId === lifecycleItem.itemId
          : lifecycleItem.body.kind === 'turn'
            ? item.sequence >= rootSequence &&
              isRootAgentJournalItem(item) &&
              (!item.turn || item.turn.turnId === turnId)
            : turnItems.length > 0
              ? item.turn?.turnId === turnId
              : item.sequence > (previousLifecycle?.sequence ?? -1) &&
                (active || item.sequence <= lifecycleItem.sequence))
  )
  const projected = projectStructuredItemsToNativeChat(scopedItems)
  const rootUserIndex = projected.findIndex(
    (message) =>
      message.role === 'user' &&
      (turnItems.length === 0 || message.id === rootId) &&
      !message.blocks.some((block) => block.type === 'tool-result') &&
      !isNoiseMessage(message)
  )
  const turnMessages =
    turnItems.length > 0 || rootUserIndex === -1 ? projected : projected.slice(rootUserIndex)
  const observedUserMessage = rootUserIndex === -1 ? undefined : turnUserMessage(turnMessages)
  const userMessage = observedUserMessage ? { ...observedUserMessage, id: turnId } : undefined
  const messages =
    turnItems.length > 0
      ? projected.filter((_, index) => index !== rootUserIndex)
      : rootUserIndex === -1
        ? turnMessages
        : turnMessages.slice(1)
  const outcome = readAgentJournalTurnOutcome(lifecycle)
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
      : outcome === 'failure'
        ? 'failed'
        : outcome === 'cancellation' || lifecycle.state === 'interrupted'
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
    state.items.findLast(
      (item) => isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)
    ) ?? null
  )
}

export async function structuredRoomMutationEnvelope(
  sessionId: string,
  method: string,
  fields: Record<string, unknown>
): Promise<AgentSessionMutationEnvelope> {
  return {
    sessionId,
    clientOperationId: structuredRoomOperationId(),
    expectedRuntimeFence: (await readStructuredRoomState(sessionId)).fence,
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
