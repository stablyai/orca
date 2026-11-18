// An owner's item comment images ride its mail's payload; a structured chat gets them as image blocks,
// as chat sends a pasted image. Only Orca's item mail carries them, and only this host's committed
// store images pass, the same admission the comment had.
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../../../../../shared/agent-session/agent-session-attachments'
import { isAgentInlineImagePath } from '../../../../../shared/native-chat/input/composer/agent-inline-image-types'
import { BOT_ITEM_MAIL_SENDER } from '../../../../../shared/bots/bot-item-note-runs'
import { parseAgentSessionAttachmentStorePath } from '../../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { getAgentSessionAttachmentStore } from '../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { MessageRow } from '../../db/orchestration-records'

export function botItemMailImageBlocks(
  message: Pick<MessageRow, 'from_handle' | 'payload'>
): { type: 'image-ref'; path: string }[] {
  const root = getAgentSessionAttachmentStore()?.rootDir
  if (message.from_handle !== BOT_ITEM_MAIL_SENDER || !message.payload || !root) {
    return []
  }
  let payload: unknown
  try {
    payload = JSON.parse(message.payload)
  } catch {
    return []
  }
  const images =
    typeof payload === 'object' && payload !== null && 'images' in payload ? payload.images : null
  return (Array.isArray(images) ? images : [])
    .filter(
      (path): path is string =>
        typeof path === 'string' &&
        isAgentInlineImagePath(path) &&
        parseAgentSessionAttachmentStorePath(root, path) !== null
    )
    .slice(0, AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT)
    .map((path) => ({ type: 'image-ref', path }))
}
