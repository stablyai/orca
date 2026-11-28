// Files a paired Orca sent with bot mail that names no item: claimed for the session the mail is
// stored in, as it is stored, so a new Home Chat or a /clear in between can't leave them claimed by
// another chat than the one that reads them. A send refused after the claim gives back exactly the
// claims it took, so its files are swept as unused.
import type { Bot } from '../../../../../../shared/bot-types'
import { isOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address'
import { getAgentSessionAttachmentReleaser } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { canonicalOrcaSessionId } from '../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { botChatTakingMail, botChatTakingMailNow } from '../../bots-chats'

/** Claims the mail's uploads for one session; resolves to the uploads it newly claimed, when known. */
export type MailFilesClaim = (sessionId: string) => Promise<readonly string[] | undefined>

/** Files claimed for the chat a mail is about to be stored in. */
export type ClaimedMailFiles = {
  /** Run in the same turn the mail is stored: refuses it when the chat moved on meanwhile. */
  current: () => void
  /** Gives back the claims this send took; false when they may still be held. */
  release: () => Promise<boolean>
}

/** Claims the files for the session running chat `chatId` now. `home`: the bot's Home Chat as its
 *  lock gives it, which may not list yet as taking mail. */
export async function claimMailFilesFor(
  runtime: Pick<
    OrcaRuntimeService,
    'ensureStructuredAgentSessionHost' | 'getOrchestrationDb' | 'lookAround'
  >,
  bot: Bot,
  chatId: string | null,
  claim: MailFilesClaim | undefined,
  home = false
): Promise<ClaimedMailFiles | undefined> {
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
  const inserted = await claim(live)
  return {
    current: () => {
      if ((botChatTakingMailNow(runtime, bot, root)?.sessionId ?? fallback) !== live) {
        throw new OrchestrationError(
          'bot_chat_changed',
          `${bot.name}'s chat moved on to a new session while uploading. Nothing was sent. Send it again.`,
          { effectsApplied: false, retryable: true }
        )
      }
    },
    release: async () => {
      const releaser = getAgentSessionAttachmentReleaser()
      if (!inserted || !releaser) {
        return inserted?.length === 0
      }
      if (inserted.length === 0) {
        return true
      }
      try {
        await releaser(live, inserted)
        return true
      } catch (error) {
        console.warn('[bots] mail files: releasing the claims of a refused send failed', error)
        return false
      }
    }
  }
}

/** Stores the mail with `admit`, given the files' current-check; a refusal or a duplicate gives back
 *  the claims this send took. A refusal that couldn't give them back is `peer_mail_files_kept`. */
export async function admitWithClaimedFiles(
  claimed: ClaimedMailFiles | undefined,
  admit: (current?: () => void) => { sent: boolean; receipt: unknown }
): Promise<unknown> {
  if (!claimed) {
    return admit().receipt
  }
  let admitted: { sent: boolean; receipt: unknown }
  try {
    admitted = admit(claimed.current)
  } catch (error) {
    if (await claimed.release()) {
      throw error
    }
    // Its own code, so the sender hears it across the pairing: other refusal codes reach it bare.
    const known = error instanceof OrchestrationError
    const data = known && typeof error.data === 'object' && error.data !== null ? error.data : {}
    throw new OrchestrationError(
      'peer_mail_files_kept',
      error instanceof Error ? error.message : String(error),
      { ...data, ...(known ? { cause: error.code } : {}), effectsApplied: false, filesKept: true }
    )
  }
  if (!admitted.sent) {
    await claimed.release()
  }
  return admitted.receipt
}
