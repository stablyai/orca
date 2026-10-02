import { randomUUID } from 'node:crypto'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import {
  projectStructuredAgentSessionStatus,
  projectStructuredItemsToNativeChat
} from '../../../shared/structured-agent-session-projection'
import type { RoomContextSnapshot } from '../../../shared/rooms'
import type { NativeChatTranscriptSubscription } from '../../native-chat/transcript-watch'
import type {
  RoomHarnessLaunchOptions,
  RoomHarnessSubscriptionCallbacks,
  RoomMachineHarnessBinding
} from './harness-adapter-types'
import { readRoomContext } from './context-reader'
import {
  latestStructuredRoomLifecycleItem,
  readStructuredRoomState,
  roomStructuredLifecycle,
  structuredRoomCaller,
  structuredRoomHost,
  structuredRoomMutationEnvelope
} from './machine-harness-session'

export async function readMachineRoomStatus(value: RoomMachineHarnessBinding) {
  if (!structuredRoomHost().hasProviderChild(value.conversationId)) {
    return { handle: value.conversationId, isRunningAgent: false, status: null }
  }
  const status = projectStructuredAgentSessionStatus(
    (await readStructuredRoomState(value.conversationId)).items
  )
  return {
    handle: value.conversationId,
    isRunningAgent: true,
    status:
      status === 'attention'
        ? ('permission' as const)
        : status === 'working'
          ? ('working' as const)
          : ('idle' as const)
  }
}

export async function readMachineRoomReady(value: RoomMachineHarnessBinding) {
  const running = structuredRoomHost().hasProviderChild(value.conversationId)
  const status = projectStructuredAgentSessionStatus(
    (await readStructuredRoomState(value.conversationId)).items
  )
  return {
    handle: value.conversationId,
    condition: 'tui-idle' as const,
    satisfied: status === 'idle',
    status: running ? ('running' as const) : ('exited' as const),
    exitCode: null
  }
}

export const machineRoomInputReady = async (value: RoomMachineHarnessBinding): Promise<boolean> =>
  projectStructuredAgentSessionStatus(
    (await readStructuredRoomState(value.conversationId)).items
  ) === 'idle'

export async function readMachineRoomContext(
  agent: Parameters<typeof readRoomContext>[0],
  value: RoomMachineHarnessBinding,
  current: RoomContextSnapshot
): Promise<RoomContextSnapshot> {
  const host = structuredRoomHost()
  const context = host.readContext(value.conversationId)
  if (context) {
    return context
  }
  const { providerSession } = await host.history({
    sessionId: value.conversationId,
    direction: 'tail',
    limit: 1
  })
  return providerSession ? readRoomContext(agent, providerSession, current) : current
}

export const machineRoomLastActivityAt = async (
  value: RoomMachineHarnessBinding
): Promise<number> =>
  (await readStructuredRoomState(value.conversationId)).items.at(-1)?.observedAt ?? Date.now()

export async function subscribeMachineRoomSession(
  value: RoomMachineHarnessBinding,
  callbacks: RoomHarnessSubscriptionCallbacks
): Promise<NativeChatTranscriptSubscription> {
  let state: StructuredAgentSessionState = EMPTY_STRUCTURED_AGENT_SESSION
  let lastLifecycle = ''
  const host = structuredRoomHost()
  const unsubscribe = await host.subscribe({
    id: `room:${value.conversationId}:${randomUUID()}`,
    sessionId: value.conversationId,
    emit: (event) => {
      if (event.type === 'end') {
        return
      }
      state = reduceStructuredAgentSession(state, { type: 'event', event })
      const messages = projectStructuredItemsToNativeChat(state.items)
      if (event.type === 'snapshot' || event.type === 'reset') {
        callbacks.onSnapshot(messages)
      }
      const lifecycle = roomStructuredLifecycle(
        state,
        event.type === 'snapshot' || event.type === 'reset'
      )
      const lifecycleItem = latestStructuredRoomLifecycleItem(state)
      const lifecycleIdentity =
        lifecycle && lifecycleItem
          ? `${state.epoch ?? ''}:${lifecycleItem.itemId}:${lifecycleItem.revision}:${lifecycle.type}`
          : ''
      const lifecycleKey =
        lifecycle?.type === 'activity' && !lifecycle.replay
          ? `${lifecycleIdentity}:${state.cursor?.sequence ?? 0}`
          : `${lifecycleIdentity}:${lifecycle?.userMessage?.id ?? ''}`
      if (lifecycle && lifecycleKey !== lastLifecycle) {
        lastLifecycle = lifecycleKey
        callbacks.onEvent(lifecycle)
      }
    }
  })
  return { watching: true, unsubscribe }
}

export async function applyMachineRoomPreferences(
  value: RoomMachineHarnessBinding,
  preferences?: RoomHarnessLaunchOptions['preferences']
): Promise<void> {
  const available = structuredRoomHost().readConfiguration(value.conversationId)?.options
  for (const [key, rawValue] of Object.entries(preferences ?? {})) {
    if (
      rawValue === undefined ||
      (available && !available.some((option) => option.id === key && option.settable))
    ) {
      continue
    }
    const stringValue = String(rawValue)
    const result = await structuredRoomHost().setOption(structuredRoomCaller(value), {
      envelope: await structuredRoomMutationEnvelope(
        value.conversationId,
        'agentSession.setOption',
        {
          key,
          value: stringValue
        }
      ),
      key,
      value: stringValue
    })
    if (!result.ok) {
      throw new Error(result.refusal.message)
    }
  }
}
