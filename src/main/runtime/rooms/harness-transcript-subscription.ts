import type { RoomHarnessAgent } from '../../../shared/rooms'
import {
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription
} from '../../native-chat/transcript-watch'
import type {
  RoomHarnessSubscriptionCallbacks,
  RoomTerminalHarnessBinding
} from './harness-adapter-types'
import { currentTurnMessages, transcriptLifecycleEvent, turnUserMessage } from './harness-lifecycle'

export function subscribeRoomHarnessTranscript(
  agent: RoomHarnessAgent,
  binding: RoomTerminalHarnessBinding,
  callbacks: RoomHarnessSubscriptionCallbacks
): Promise<NativeChatTranscriptSubscription> {
  const session = binding.providerSession
  if (!session) {
    return Promise.resolve({ watching: false, unsubscribe: () => {} })
  }
  return subscribeNativeChatTranscript({
    agent,
    sessionId: session.id,
    transcriptPath: session.transcriptPath,
    initialLimit: 200,
    onInitialSnapshot: (messages, _hasMore, _beforeOffset, _error, lifecycle) => {
      callbacks.onSnapshot(messages)
      const event = transcriptLifecycleEvent(
        currentTurnMessages(messages),
        lifecycle,
        true,
        turnUserMessage(messages)
      )
      if (event) {
        callbacks.onEvent(event)
      }
    },
    onReplace: (messages, _hasMore, _beforeOffset, lifecycle) => {
      callbacks.onSnapshot(messages)
      const event = transcriptLifecycleEvent(
        currentTurnMessages(messages),
        lifecycle,
        true,
        turnUserMessage(messages)
      )
      if (event) {
        callbacks.onEvent(event)
      }
    },
    onAppend: (messages, lifecycle) => {
      const userMessage = turnUserMessage(messages)
      if (!userMessage) {
        const event = transcriptLifecycleEvent(messages, lifecycle)
        if (event) {
          callbacks.onEvent(event)
        }
        return
      }
      const rootIndex = messages.findLastIndex(
        (message) => turnUserMessage([message])?.id === userMessage.id
      )
      const activityMessages = messages
        .slice(rootIndex + 1)
        .filter((message) => message.role !== 'user')
      const event = transcriptLifecycleEvent(
        [messages[rootIndex]!, ...activityMessages],
        lifecycle,
        false,
        userMessage
      )
      if (!event) {
        return
      }
      callbacks.onEvent({
        ...event,
        messages: activityMessages
      })
    },
    onOpaqueAppend: callbacks.onOpaqueAppend
  })
}
