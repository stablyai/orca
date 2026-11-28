// `send --to bot:<name> --item <n> --file`: files sent with mail about an item, admitted into that
// item's chat as its comments' are. Images go with the mail as the chat's image blocks; other files
// join the body as `@path`. A paired Orca's files arrive already uploaded to this store, and with no
// item they go into the chat the mail lands in (the `--chat` it names, or the Home Chat), claimed
// for it as the mail is stored there.
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
import { botChatTakingMail } from '../../bots-chats'
import type { MailFilesClaim } from './bot-mail-files-claim'

const NOTHING_SENT = { effectsApplied: false } as const

type ItemMail = {
  to: string
  params: { item?: string; body?: string; files?: string[] }
  attachments?: readonly string[]
  images?: readonly string[]
}

export async function withItemMailFiles<T extends ItemMail>(
  runtime: OrcaRuntimeService,
  mail: T,
  /** `--chat new`: no chat yet that its files could go to. */
  newChat = false
): Promise<T & { claimFiles?: MailFilesClaim; peerFiles?: boolean }> {
  const local = mail.params.files ?? []
  const uploaded = mail.attachments ?? []
  if (local.length === 0 && uploaded.length === 0) {
    return mail
  }
  const name = parseBotAddress(mail.to)
  const bot = name === null ? undefined : botOfAddress(runtime.bots.list(), name)
  const { item } = mail.params
  // This computer's own files go only with an item: its bots read a path here as it is.
  if ((item === undefined && local.length > 0) || !bot) {
    throw new OrchestrationError(
      'invalid_argument',
      "--file goes with --to bot:<name> --item <n>: the files go to that item's chat. Nothing was sent.",
      NOTHING_SENT
    )
  }
  if (item === undefined && newChat) {
    throw new OrchestrationError(
      'invalid_argument',
      '--file goes into a chat the bot already has: drop --chat new to use its Home Chat, or name one with --chat <id>. Nothing was sent.',
      NOTHING_SENT
    )
  }
  // With an item, its chat claims them now; other mail's chat is chosen, and claims them, as it is stored.
  const itemChat =
    item === undefined ? null : (await resolveItem(runtime.botItems.store(), item)).chatId
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const others = uploaded.filter((path) => !isAgentInlineImagePath(path))
  const body = [mail.params.body?.trimEnd(), others.map(formatNativeChatFileReference).join('\n')]
    .filter(Boolean)
    .join('\n\n')
  try {
    const { text, images, claimFor } = await admitBotItemCommentAttachments(
      {
        store: getAgentSessionAttachmentStore(),
        local: local.length > 0,
        claim: getAgentSessionAttachmentClaimer(),
        chat: itemChat === null ? 'later' : () => botChatTakingMail(runtime, bot, itemChat)
      },
      body,
      uploaded.filter(isAgentInlineImagePath),
      local
    )
    return {
      ...mail,
      params: { ...mail.params, body: text },
      images: images.map(({ path }) => path),
      ...(uploaded.length > 0 ? { peerFiles: true } : {}),
      ...(claimFor
        ? { claimFiles: (sessionId: string) => notSentOnRefusal(claimFor(sessionId)) }
        : {})
    }
  } catch (error) {
    throw notSent(error)
  }
}

function notSent(error: unknown): unknown {
  return error instanceof BotItemError
    ? new OrchestrationError('invalid_argument', `${error.message} Nothing was sent.`, NOTHING_SENT)
    : error
}

async function notSentOnRefusal<T>(claim: Promise<T>): Promise<T> {
  try {
    return await claim
  } catch (error) {
    throw notSent(error)
  }
}

/** The mail's body with its images named as `@path` too, for mail that carries no image blocks. */
export function itemMailFilesBody(mail: Pick<ItemMail, 'params' | 'images'>): string {
  const images = (mail.images ?? []).map(formatNativeChatFileReference).join('\n')
  return [mail.params.body?.trimEnd(), images].filter(Boolean).join('\n\n')
}
