// `send --to bot:<name> --item <n> --file`: files sent with mail about an item, admitted into that
// item's chat as its comments' are. Images go with the mail as the chat's image blocks; other files
// join the body as `@path`. A paired Orca's files arrive already uploaded to this store, and with no
// item they go into the chat the mail lands in: the `--chat` it names, or the Home Chat.
import { isAgentInlineImagePath } from '../../../../../../shared/native-chat/input/composer/agent-inline-image-types'
import { formatNativeChatFileReference } from '../../../../../../shared/native-chat/input/composer/agent-image-paste'
import { parseBotAddress, botOfAddress } from '../../../../../../shared/bot-roster'
import { admitBotItemCommentAttachments } from '../../../../../bots/bot-item-comment-attachments'
import { BotItemError } from '../../../../../bots/bot-item-error'
import {
  getAgentSessionAttachmentClaimer,
  getAgentSessionAttachmentStore
} from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolveItem } from '../../bots-items-write-support'
import { botChatTakingMail, botChatTakingMailNow } from '../../bots-chats'
import { refuse } from './bot-recipient'
import { runtimeBotChats } from '../../../../../bots/bot-chat-session'
import type { Bot } from '../../../../../../shared/bot-types'
import {
  parseOrcaSessionAddress,
  type OrcaSessionAddress
} from '../../../../../../shared/agent-session/identity/orca-session-address'

type ItemMail = {
  to: string
  params: { item?: string; body?: string; files?: string[] }
  attachments?: readonly string[]
  images?: readonly string[]
}

export async function withItemMailFiles<T extends ItemMail>(
  runtime: OrcaRuntimeService,
  mail: T,
  /** Where mail with no item lands: the `--chat` address it named, or a new chat. */
  landing: { named?: OrcaSessionAddress; newChat?: boolean } = {}
): Promise<T> {
  const local = mail.params.files ?? []
  const uploaded = mail.attachments ?? []
  if (local.length === 0 && uploaded.length === 0) {
    return mail
  }
  const name = parseBotAddress(mail.to)
  const bot = name === null ? undefined : botOfAddress(runtime.bots.list(), name)
  // This computer's own files go only with an item: its bots read a path here as it is.
  if ((mail.params.item === undefined && local.length > 0) || !bot) {
    throw new OrchestrationError(
      'invalid_argument',
      "--file goes with --to bot:<name> --item <n>: the files go to that item's chat. Nothing was sent."
    )
  }
  if (mail.params.item === undefined && landing.newChat) {
    throw new OrchestrationError(
      'invalid_argument',
      '--file goes into a chat the bot already has: drop --chat new to use its Home Chat, or name one with --chat <id>. Nothing was sent.'
    )
  }
  const chat = await filesChat(runtime, bot, mail.params.item, landing.named)
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const others = uploaded.filter((path) => !isAgentInlineImagePath(path))
  const body = [mail.params.body?.trimEnd(), others.map(formatNativeChatFileReference).join('\n')]
    .filter(Boolean)
    .join('\n\n')
  try {
    const { text, images } = await admitBotItemCommentAttachments(
      {
        store: getAgentSessionAttachmentStore(),
        local: local.length > 0,
        claim: getAgentSessionAttachmentClaimer(),
        chat
      },
      body,
      uploaded.filter(isAgentInlineImagePath),
      local
    )
    return {
      ...mail,
      params: { ...mail.params, body: text },
      images: images.map(({ path }) => path)
    }
  } catch (error) {
    if (error instanceof BotItemError) {
      throw new OrchestrationError('invalid_argument', `${error.message} Nothing was sent.`)
    }
    throw error
  }
}

/** The chat that claims the mail's files: the item's, else the named chat, else the Home Chat (made on
 *  first use, as the mail itself would make it). */
async function filesChat(
  runtime: OrcaRuntimeService,
  bot: Bot,
  item: string | undefined,
  named: OrcaSessionAddress | undefined
): Promise<() => Promise<{ sessionId: string; title: string | null } | null>> {
  if (item !== undefined) {
    const { chatId } = await resolveItem(runtime.botItems.store(), item)
    return () => botChatTakingMail(runtime, bot, chatId)
  }
  const id = named ? parseOrcaSessionAddress(named) : null
  if (id) {
    return async () =>
      (await botChatTakingMail(runtime, bot, id)) ??
      refuse({
        code: 'bot_chat_not_found',
        message: `Chat ${id} of ${bot.name} takes no mail now, so the files can't go there. Pick one that \`orca bot chats --bot "${bot.name}"\` lists. Nothing was sent.`
      })
  }
  return async () => {
    const home = await runtimeBotChats(runtime).ensure(bot.id)
    return botChatTakingMailNow(runtime, bot, home) ?? { sessionId: home, title: null }
  }
}

/** The mail's body with its images named as `@path` too, for mail that carries no image blocks. */
export function itemMailFilesBody(mail: Pick<ItemMail, 'params' | 'images'>): string {
  const images = (mail.images ?? []).map(formatNativeChatFileReference).join('\n')
  return [mail.params.body?.trimEnd(), images].filter(Boolean).join('\n\n')
}
