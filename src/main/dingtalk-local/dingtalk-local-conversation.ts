import type { ConversationKey } from '../external-conversations/external-conversation-types'
import type { DingTalkExternalId } from './dingtalk-domain'

export function conversationKey(externalId: DingTalkExternalId): ConversationKey {
  return { source: 'dingtalk', externalId }
}
