import { recordRemoteStructuredChatTelemetry } from '../../telemetry/structured-chat-dispatch'
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
      payload.response.ok &&
      recordRemoteStructuredChatTelemetry(payload.response.result)
    ) {
      return
    }
    onEvent(payload)
  })
}
