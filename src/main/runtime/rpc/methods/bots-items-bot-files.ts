// A bot's `--file` on an item comment: files on this host's disk (its CLI runs here), copied into the
// item chat's attachment store and claimed for that chat through the owner's own admission.
import {
  admitBotItemCommentAttachments,
  type BotItemCommentAttached
} from '../../../bots/bot-item-comment-attachments'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { sanitizeAgentSessionAttachmentName } from '../../../../shared/agent-session/agent-session-attachments'
import { BOT_ITEM_LIMITS } from '../../../../shared/bots/bot-items'
import { isAgentInlineImagePath } from '../../../../shared/native-chat/input/composer/agent-inline-image-types'
import { formatNativeChatFileReference } from '../../../../shared/native-chat/input/composer/agent-image-paste'
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
  assertFitsWithFiles(getAgentSessionAttachmentStore()?.rootDir, text, files)
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

/** The comment with each non-image file's `@path` (store paths are a fixed length past the name) must
 *  fit the item's text limit; refused before any file is copied. */
function assertFitsWithFiles(
  root: string | undefined,
  text: string,
  files: readonly string[]
): void {
  if (!root) {
    return
  }
  const paths = files
    .filter((path) => !isAgentInlineImagePath(path))
    .map((path) =>
      formatNativeChatFileReference(
        join(root, randomUUID(), sanitizeAgentSessionAttachmentName(basename(path)))
      )
    )
  const length = text.trimEnd().length + paths.reduce((sum, ref) => sum + ref.length + 2, 0)
  if (length > BOT_ITEM_LIMITS.text) {
    throw new BotItemError(
      'invalid_argument',
      `The comment and its files' paths come to ${length} characters; the limit is ${BOT_ITEM_LIMITS.text}. Shorten the comment. Nothing was posted.`
    )
  }
}
