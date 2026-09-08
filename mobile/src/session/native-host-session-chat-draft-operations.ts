import type { HostSessionChatDraftOperations } from './host-session-chat-draft-operations'
import {
  loadMobileSessionChatDraft,
  saveMobileSessionChatDraft
} from '../storage/mobile-session-chat-drafts'

const NATIVE_MOBILE_BUILD_IDENTITY = 'native-mobile-v1'

export function nativeHostSessionChatDraftOperations(
  hostId: string
): HostSessionChatDraftOperations {
  return {
    load(workspaceId, tabId) {
      return loadMobileSessionChatDraft({
        hostIdentity: hostId,
        buildIdentity: NATIVE_MOBILE_BUILD_IDENTITY,
        workspaceIdentity: workspaceId,
        tabIdentity: tabId
      })
    },
    save(workspaceId, tabId, text) {
      return saveMobileSessionChatDraft(
        {
          hostIdentity: hostId,
          buildIdentity: NATIVE_MOBILE_BUILD_IDENTITY,
          workspaceIdentity: workspaceId,
          tabIdentity: tabId
        },
        text
      )
    }
  }
}
