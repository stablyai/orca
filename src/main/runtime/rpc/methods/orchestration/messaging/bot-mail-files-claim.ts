// Files a paired Orca sent with bot mail that names no item: claimed for the session the mail is
// stored in, as it is stored, so a new Home Chat or a /clear in between can't leave them claimed by
// another chat than the one that reads them. A send refused after the claim gives back exactly the
// claims it took, so its files are swept as unused.
import type { Bot } from '../../../../../../shared/bot-types'
import { isOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address'
import {
  getAgentSessionAttachmentReleaser,
  type AgentSessionAttachmentClaimed
} from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { canonicalOrcaSessionId } from '../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { botChatTakingMail, botChatTakingMailNow } from '../../bots-chats'

/** Claims the mail's uploads for one session; resolves to the claims it newly took, when known. */
export type MailFilesClaim = (
  sessionId: string
) => Promise<AgentSessionAttachmentClaimed | undefined>

/** What storing the mail tells its claimed files. */
export type AdmitFiles = {
  /** Run in the same turn the mail is stored: refuses it when the chat moved on meanwhile. */
  current: () => void
  /** The mail is stored: from here its files' claims are its own and stay, whatever fails next. */
  stored: () => void
}

/** Files claimed for the chat a mail is about to be stored in. */
export type ClaimedMailFiles = AdmitFiles & {
  isStored: () => boolean
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
  const claimed = await claim(live)
  let stored = false
  return {
    stored: () => {
      stored = true
    },
    isStored: () => stored,
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
      if (!claimed || claimed.uploadIds.length === 0) {
        return claimed !== undefined
      }
      if (!releaser) {
        return false
      }
      try {
        await releaser(live, claimed)
        return true
      } catch (error) {
        console.warn('[bots] mail files: releasing the claims of a refused send failed', error)
        return false
      }
    }
  }
}

/** Stores the mail with `admit`, given the files' checks. A refusal or a duplicate gives back the
 *  claims this send took; one that couldn't give them back is `peer_mail_files_kept`. A failure
 *  after the mail is stored keeps them, since the stored mail reads them: `peer_mail_stored`. */
export async function admitWithClaimedFiles(
  claimed: ClaimedMailFiles | undefined,
  admit: (files?: AdmitFiles) => { sent: boolean; receipt: unknown }
): Promise<unknown> {
  if (!claimed) {
    return admit().receipt
  }
  let admitted: { sent: boolean; receipt: unknown }
  try {
    admitted = admit(claimed)
  } catch (error) {
    // Codes of their own, so the sender hears them across the pairing: others reach it bare.
    if (claimed.isStored()) {
      throw relabeled(
        error,
        'peer_mail_stored',
        { effectsApplied: true },
        (reason) => `The message was delivered with its files, then this failed: ${reason}`
      )
    }
    if (await claimed.release()) {
      throw error
    }
    throw relabeled(error, 'peer_mail_files_kept', { effectsApplied: false, filesKept: true })
  }
  // No paired mail is a duplicate today (its request carries no turn to match): kept for local use.
  if (!admitted.sent && !(await claimed.release())) {
    console.warn('[bots] mail files: a duplicate request keeps the files its send claimed')
  }
  return admitted.receipt
}

function relabeled(
  error: unknown,
  code: string,
  extra: object,
  say: (reason: string) => string = (reason) => reason
): OrchestrationError {
  const known = error instanceof OrchestrationError
  const data = known && typeof error.data === 'object' && error.data !== null ? error.data : {}
  return new OrchestrationError(code, say(error instanceof Error ? error.message : String(error)), {
    ...data,
    ...(known ? { cause: error.code } : {}),
    ...extra
  })
}
