// Files a paired Orca sent with bot mail that names no item: claimed for the session the mail is
// stored in, as it is stored, so a new Home Chat or a /clear in between can't leave them claimed by
// another chat than the one that reads them.
import type { Bot } from '../../../../../../shared/bot-types'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { botChatTakingMail, botChatTakingMailNow } from '../../bots-chats'
import { isOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'

/** Claims the mail's uploads for one session. */
export type MailFilesClaim = (sessionId: string) => Promise<void>

/** Claims the files for the session running chat `chatId` now; the returned check runs in the same
 *  turn the mail is stored, and refuses it when that chat moved on to another session meanwhile.
 *  `home`: the bot's Home Chat as its lock gives it, which may not list yet as taking mail. */
export async function claimMailFilesFor(
  runtime: Pick<
    OrcaRuntimeService,
    'ensureStructuredAgentSessionHost' | 'getOrchestrationDb' | 'lookAround'
  >,
  bot: Bot,
  chatId: string | null,
  claim: MailFilesClaim | undefined,
  home = false
): Promise<(() => void) | undefined> {
  if (!claim) {
    return undefined
  }
  // A chat is known by its /clear root, whichever of its sessions the mail named.
  const root = chatId && isOrcaSessionId(chatId) ? canonicalOrcaSessionId(chatId) : chatId
  const fallback = home ? root : null
  const live = root ? ((await botChatTakingMail(runtime, bot, root))?.sessionId ?? fallback) : null
  if (!root || !live) {
    throw new OrchestrationError(
      'bot_chat_not_found',
      `This chat of ${bot.name} isn't taking mail now, so files can't go there. Send without --chat to use its Home Chat, or pick a chat that orca bot chats --environment <server> --bot "${bot.name}" lists. Nothing was sent.`,
      { effectsApplied: false }
    )
  }
  await claim(live)
  return () => {
    if ((botChatTakingMailNow(runtime, bot, root)?.sessionId ?? fallback) !== live) {
      throw new OrchestrationError(
        'bot_chat_changed',
        `${bot.name}'s chat moved on to a new session while uploading. Nothing was sent. Send it again.`,
        { effectsApplied: false, retryable: true }
      )
    }
  }
}
