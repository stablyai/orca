import type { HostSessionChatDraftOperations } from './host-session-chat-draft-operations'
import { nativeHostSessionChatDraftOperations } from './native-host-session-chat-draft-operations'

export function defaultHostSessionChatDraftOperations(
  hostId: string
): HostSessionChatDraftOperations {
  return nativeHostSessionChatDraftOperations(hostId)
}
