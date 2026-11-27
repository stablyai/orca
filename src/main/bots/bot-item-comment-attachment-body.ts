import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../shared/agent-session/agent-session-attachments'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { botItemCommentImages, type BotItemCommentImage } from '../../shared/bots/bot-items'
import type { BotItemEventRecord } from './bot-items-schema'

export function botItemCommentAttachmentBody(
  text: string,
  images: readonly Pick<BotItemCommentImage, 'path'>[]
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text },
      ...images.map(({ path }) => ({ type: 'image-ref' as const, path }))
    ]
  }
}

export function ownerCommentAttachmentBody(
  event: BotItemEventRecord
): AgentJournalMessageItem | null {
  if (event.kind !== 'commented' || event.actor.kind !== 'owner') {
    return null
  }
  const text = typeof event.data.text === 'string' ? event.data.text : ''
  const images = botItemCommentImages(event.data)
  return images.length > 0 || text.toLowerCase().includes(AGENT_SESSION_ATTACHMENTS_DIR_NAME)
    ? botItemCommentAttachmentBody(text, images)
    : null
}
