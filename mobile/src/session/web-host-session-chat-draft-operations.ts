import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostSessionChatDraftOperations } from './host-session-chat-draft-operations'

export function webHostSessionChatDraftOperations(
  client: MobileWebBridgeClient
): HostSessionChatDraftOperations {
  return {
    async load(workspaceId, tabId) {
      return (await client.native.sessionChatDraftRead(workspaceId, tabId)).text
    },
    async save(workspaceId, tabId, text) {
      await client.native.sessionChatDraftWrite(workspaceId, tabId, text)
    }
  }
}
