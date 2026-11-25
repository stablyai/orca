import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../src/shared/agent-session/view/structured-agent-session-message-projection'
import { structuredAgentSessionSendBody } from '../../../../../../src/shared/agent-session/requests/structured-agent-session-send-mutation'
import { nativeChatTextWithFileReferences } from '../attachments/mobile-native-chat-file-attachment'
import { readMobileNativeChatInFlightStructuredSession } from './mobile-native-chat-in-flight-sends'

export function retainMobileStructuredSends(
  scope: string,
  sessionId: string,
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  queuedIds: readonly string[]
): readonly StructuredAgentSessionOptimisticMessage[] {
  const retained = readMobileNativeChatInFlightStructuredSession(sessionId, scope).filter(
    (send) => send.deliveryUnconfirmed
  )
  if (!retained.length) {
    return optimistic
  }
  const queued = new Set(queuedIds)
  const byId = new Map(optimistic.map((entry) => [entry.clientMessageId, entry]))
  for (const send of retained) {
    const id = send.clientMessageId ?? send.id
    // A queued send keeps its card ID as the saved entry's ID, even when its journal row is off-page.
    if (queued.has(id) || queued.has(send.id)) {
      byId.delete(id)
      continue
    }
    byId.set(id, {
      clientMessageId: id,
      body: structuredAgentSessionSendBody(
        nativeChatTextWithFileReferences(send.text, send.files),
        send.images
      ),
      queuedAt: null,
      retainedSendId: send.id
    })
  }
  return [...byId.values()]
}
