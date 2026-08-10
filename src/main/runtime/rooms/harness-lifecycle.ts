import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../../shared/native-chat-types'
import { isNoiseMessage } from '../../../shared/native-chat-noise'
import { isSubagentToolName } from '../../../shared/native-chat-tool-name'
import { briefToolArg } from '../../../shared/native-chat-tool-summary'
import { roomActivityKindFromTool } from '../../../shared/room-activity'

export type RoomHarnessActivityKind =
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'command'
  | 'web'
  | 'working'

export type RoomHarnessTurnUserMessage = { id: string; text: string }

export type RoomHarnessLifecycleEvent = {
  type: 'activity' | 'final' | 'failed' | 'interrupted'
  source: 'transcript' | 'status'
  turnId: string | null
  timestamp: number
  messages: NativeChatMessage[]
  /** The user prompt that opened the turn this event belongs to, when observed. */
  userMessage?: RoomHarnessTurnUserMessage
  replay?: true
  activity?: { kind: RoomHarnessActivityKind; detail?: string }
  text?: string
}

export function roomHarnessStatusEvent(
  event: AgentHookEventPayload & { receivedAt: number }
): RoomHarnessLifecycleEvent | null {
  const payload = event.payload
  if (payload.interrupted) {
    return statusEvent('interrupted', event)
  }
  if (event.hookEventName?.replaceAll(/[^a-z]/gi, '').toLowerCase() === 'stopfailure') {
    return statusEvent('failed', event)
  }
  if (payload.state === 'done') {
    return statusEvent('final', event)
  }
  if (payload.state === 'working' || payload.state === 'blocked' || payload.state === 'waiting') {
    return {
      ...statusEvent('activity', event),
      activity: activityFromTool(payload.toolName, payload.toolInput, payload.toolInput)
    }
  }
  return null
}

export function transcriptLifecycleEvent(
  messages: NativeChatMessage[],
  lifecycle?: NativeChatTurnLifecycle,
  replay = false,
  userMessage?: RoomHarnessTurnUserMessage
): RoomHarnessLifecycleEvent | null {
  const type =
    lifecycle?.state === 'completed'
      ? 'final'
      : lifecycle?.state === 'interrupted'
        ? 'interrupted'
        : messages.length > 0 || lifecycle?.state === 'working'
          ? 'activity'
          : null
  if (!type) {
    return null
  }
  const timestamp =
    lifecycle?.timestamp ?? messages.findLast((message) => message.timestamp !== null)?.timestamp
  const turnUser = userMessage ?? turnUserMessage(messages)
  return {
    type,
    source: 'transcript',
    turnId: lifecycle?.turnId ?? null,
    timestamp: timestamp ?? Date.now(),
    messages,
    ...(turnUser ? { userMessage: turnUser } : {}),
    ...(replay ? { replay: true as const } : {}),
    ...(type === 'activity' ? { activity: activityFromMessages(messages) } : {})
  }
}

export function currentTurnMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  const lastUser = messages.findLastIndex((message) => message.role === 'user')
  return lastUser === -1 ? [] : messages.slice(lastUser + 1)
}

/** The latest real user prompt in a batch — tool-result and harness-noise user
 *  rows are turn continuations, not new user-authored generations. */
export function turnUserMessage(
  messages: NativeChatMessage[]
): RoomHarnessTurnUserMessage | undefined {
  const user = messages.findLast(
    (message) =>
      message.role === 'user' &&
      !message.blocks.some((block) => block.type === 'tool-result') &&
      !isNoiseMessage(message)
  )
  if (!user) {
    return undefined
  }
  const text = user.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text ? { id: user.id, text } : undefined
}

function statusEvent(
  type: RoomHarnessLifecycleEvent['type'],
  event: AgentHookEventPayload & { receivedAt: number }
): RoomHarnessLifecycleEvent {
  const toolMessage = event.isReplay ? null : toolActivityMessage(event)
  return {
    type,
    source: 'status',
    turnId: event.promptInteractionKey ?? null,
    timestamp: event.receivedAt,
    messages: toolMessage ? [toolMessage] : [],
    ...(event.payload.lastAssistantMessage
      ? { text: event.payload.lastAssistantMessage.trim() }
      : {})
  }
}

function toolActivityMessage(
  event: AgentHookEventPayload & { receivedAt: number }
): NativeChatMessage | null {
  const activity = event.toolActivity
  const toolUseId = event.toolUseId?.trim()
  const toolName = event.payload.toolName?.trim()
  if (!activity || !toolUseId || !toolName) {
    return null
  }
  return {
    id: `hook:${toolUseId}`,
    turnId: toolUseId,
    role: 'tool',
    blocks: [
      { type: 'tool-call', name: toolName, input: activity.input ?? null },
      ...(activity.output !== undefined
        ? [{ type: 'tool-result' as const, output: activity.output, isError: activity.isError }]
        : [])
    ],
    timestamp: event.receivedAt,
    source: 'hook'
  }
}

function activityFromMessages(messages: NativeChatMessage[]): {
  kind: RoomHarnessActivityKind
  detail?: string
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const tool = message?.blocks.findLast((block) => block.type === 'tool-call')
    if (tool?.type === 'tool-call') {
      return activityFromTool(tool.name, tool.input, briefToolArg(tool.input))
    }
    if (message?.role === 'reasoning') {
      return { kind: 'thinking' }
    }
  }
  return { kind: messages.length > 0 ? 'thinking' : 'working' }
}

function activityFromTool(
  toolName: string | undefined,
  input: unknown,
  detail: string | undefined
): { kind: RoomHarnessActivityKind; detail?: string } {
  const kind = roomActivityKindFromTool(toolName, input)
  return {
    kind,
    ...(toolName && !isSubagentToolName(toolName) && detail?.trim()
      ? { detail: detail.trim() }
      : {})
  }
}
