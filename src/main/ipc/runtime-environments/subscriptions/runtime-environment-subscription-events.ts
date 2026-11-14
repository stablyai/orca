import { recordRemoteStructuredChatTelemetry } from '../../../telemetry/structured-chat-dispatch'
import { decodeSessionTabsDeltaEvents } from './runtime-environment-session-tabs-delta-decoding'

export function decodeRuntimeEnvironmentSubscriptionEvents(
  method: string,
  onEvent: Parameters<typeof decodeSessionTabsDeltaEvents>[1],
  isCurrent: () => boolean
): typeof onEvent {
  return decodeSessionTabsDeltaEvents(method, (payload) => {
    if (
      method === 'runtime.clientEvents.subscribe' &&
      isCurrent() &&
      payload.type === 'response' &&
      payload.response.ok
    ) {
      const event = payload.response.result
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        (event.type === 'structuredChatMessageDispatch' ||
          event.type === 'structuredChatPromptAccepted' ||
          event.type === 'structuredChatAgentStart') &&
        recordRemoteStructuredChatTelemetry(event)
      ) {
        return
      }
    }
    onEvent(payload)
  })
}
