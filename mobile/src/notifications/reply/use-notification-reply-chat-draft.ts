import { notificationReplyPaneDraftScope } from './notification-reply-draft-handoff'
import { useCallback } from 'react'
import { appendNotificationReplyDraftText } from './notification-reply-draft-text'
import { editMobileNativeChatDraft } from '../../session/native-chat/composer/drafts/mobile-native-chat-draft-store'
import {
  loadMobileNativeChatDrafts,
  persistMobileNativeChatDrafts
} from '../../session/native-chat/composer/drafts/mobile-native-chat-draft-persistence'
import { useNotificationReplyDrafts } from './use-notification-reply-drafts'

export function useNotificationReplyChatDraft(
  hostId: string,
  worktreeId: string,
  scope: string | null,
  paneKey?: string | null
): void {
  const restore = useCallback(
    async (text: string) => {
      if (!scope || !(await loadMobileNativeChatDrafts(hostId, worktreeId))) {
        return false
      }
      editMobileNativeChatDraft(scope, (current) => appendNotificationReplyDraftText(current, text))
      return persistMobileNativeChatDrafts(hostId, worktreeId)
    },
    [hostId, scope, worktreeId]
  )
  const handoffScope =
    paneKey === undefined
      ? scope
      : paneKey
        ? notificationReplyPaneDraftScope(hostId, worktreeId, paneKey)
        : null
  useNotificationReplyDrafts(handoffScope, restore)
}
