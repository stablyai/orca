// A bot's `--file` on an item comment: files on this host's disk (its CLI runs here), copied into the
// item chat's attachment store and claimed for that chat through the owner's own admission.
import {
  admitBotItemCommentAttachments,
  type BotItemCommentAttached
} from '../../../bots/bot-item-comment-attachments'
import { BotItemError } from '../../../bots/bot-item-error'
import type { BotItemRecord } from '../../../bots/bot-items-schema'
import {
  getAgentSessionAttachmentClaimer,
  getAgentSessionAttachmentStore
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { RpcContext } from '../core'
import { botChatTakingMail } from './bots-chats'

export async function admitBotItemFiles(
  context: RpcContext,
  item: BotItemRecord,
  text: string,
  files: readonly string[] | undefined
): Promise<BotItemCommentAttached> {
  if (!files?.length) {
    return { text, images: [] }
  }
  const { runtime } = context
  // The attachment store and its claims come up with the structured chat host.
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const bot = runtime.bots.list().find((entry) => entry.id === item.ownerBotId)
  try {
    return await admitBotItemCommentAttachments(
      {
        store: getAgentSessionAttachmentStore(),
        local: true,
        claim: getAgentSessionAttachmentClaimer(),
        chat: async () => (bot ? botChatTakingMail(runtime, bot, item.chatId) : null)
      },
      text,
      [],
      files
    )
  } catch (error) {
    if (error instanceof BotItemError) {
      throw new BotItemError(error.code, `${error.message} Nothing was posted.`)
    }
    throw error
  }
}
