// `send --to bot:<name> --item <n> --file`: files sent with mail about an item, admitted into that
// item's chat as its comments' are, or into the Home Chat once that chat stopped taking mail. Images go with the mail as the chat's image blocks; other files
// join the body as `@path`. A paired Orca's files arrive already uploaded to this store.
import { isAgentInlineImagePath } from '../../../../../../shared/native-chat/input/composer/agent-inline-image-types'
import { formatNativeChatFileReference } from '../../../../../../shared/native-chat/input/composer/agent-image-paste'
import { parseBotAddress, botOfAddress } from '../../../../../../shared/bot-roster'
import {
  admitBotItemCommentAttachments,
  claimBotItemCommentAttachments
} from '../../../../../bots/bot-item-comment-attachments'
import { BotItemError } from '../../../../../bots/bot-item-error'
import {
  getAgentSessionAttachmentClaimer,
  getAgentSessionAttachmentStore
} from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolveItem } from '../../bots-items-write-support'
import { botChatTakingMail, botHomeChatTakingMail } from '../../bots-chats'

type ItemMail = {
  to: string
  params: { item?: string; body?: string; files?: string[] }
  attachments?: readonly string[]
  images?: readonly string[]
}

export async function withItemMailFiles<T extends ItemMail>(
  runtime: OrcaRuntimeService,
  mail: T
): Promise<T> {
  const local = mail.params.files ?? []
  const uploaded = mail.attachments ?? []
  if (local.length === 0 && uploaded.length === 0) {
    return mail
  }
  const name = parseBotAddress(mail.to)
  const bot = name === null ? undefined : botOfAddress(runtime.bots.list(), name)
  if (mail.params.item === undefined || !bot) {
    throw new OrchestrationError(
      'invalid_argument',
      "--file goes with --to bot:<name> --item <n>: the files go to that item's chat. Nothing was sent."
    )
  }
  const item = await resolveItem(runtime.botItems.store(), mail.params.item)
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
        // The files go where the mail does: the Home Chat once the item's chat stopped taking mail.
        chat: async () =>
          (await botChatTakingMail(runtime, bot, item.chatId)) ??
          (await botHomeChatTakingMail(runtime, bot))
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
    throw nothingSent(error)
  }
}

/** The item's chat stopped taking mail after the files were claimed for it, so the mail goes to the
 *  Home Chat: they are claimed for that chat too, or its sweep could drop what the mail names. */
export async function claimItemMailFilesForHome(
  runtime: OrcaRuntimeService,
  sent: ItemMail,
  admitted: ItemMail
): Promise<void> {
  const name = parseBotAddress(sent.to)
  const bot = name === null ? undefined : botOfAddress(runtime.bots.list(), name)
  if (!bot || ((sent.params.files ?? []).length === 0 && (sent.attachments ?? []).length === 0)) {
    return
  }
  await claimBotItemCommentAttachments(
    {
      store: getAgentSessionAttachmentStore(),
      claim: getAgentSessionAttachmentClaimer(),
      chat: () => botHomeChatTakingMail(runtime, bot)
    },
    admitted.params.body ?? '',
    (admitted.images ?? []).map((path) => ({ path }))
  ).catch((error: unknown) => {
    throw nothingSent(error)
  })
}

function nothingSent(error: unknown): unknown {
  return error instanceof BotItemError
    ? new OrchestrationError('invalid_argument', `${error.message} Nothing was sent.`)
    : error
}

/** The mail's body with its images named as `@path` too, for mail that carries no image blocks. */
export function itemMailFilesBody(mail: Pick<ItemMail, 'params' | 'images'>): string {
  const images = (mail.images ?? []).map(formatNativeChatFileReference).join('\n')
  return [mail.params.body?.trimEnd(), images].filter(Boolean).join('\n\n')
}
