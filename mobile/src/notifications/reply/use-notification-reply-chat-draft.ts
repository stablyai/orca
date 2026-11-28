import { useCallback } from 'react'
import { appendReturnedDraftText } from '../../../../src/shared/native-chat/input/drafts/returned-draft-text'
import { editMobileNativeChatDraft } from '../../session/native-chat/composer/drafts/mobile-native-chat-draft-store'
import {
  loadMobileNativeChatDrafts,
  persistMobileNativeChatDrafts
} from '../../session/native-chat/composer/drafts/mobile-native-chat-draft-persistence'
import { useNotificationReplyDrafts } from './use-notification-reply-drafts'

export function useNotificationReplyChatDraft(
  hostId: string,
  worktreeId: string,
  scope: string | null
): void {
  const restore = useCallback(
    async (text: string) => {
      if (!scope || !(await loadMobileNativeChatDrafts(hostId, worktreeId))) {
        return false
      }
      editMobileNativeChatDraft(scope, (current) => appendReturnedDraftText(current, text))
      return persistMobileNativeChatDrafts(hostId, worktreeId)
    },
    [hostId, scope, worktreeId]
  )
  useNotificationReplyDrafts(scope, restore)
}
