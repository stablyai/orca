// A new bot speaks first. When that first turn ends before it says anything (stopped, a crash, a
// restart), Orca sends it once more the next time the bot's page opens, so a new bot never sits silent.
import type { AgentJournalSnapshot } from '../../shared/agent-session/journal/agent-session-journal-types'
import { BOT_CREATED_KICKOFF } from '../../shared/bot-created-kickoff'
import { botFirstKickoff } from '../../shared/bots/bot-import'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { Bot } from '../../shared/bot-types'
import { botMessageBody } from './bot-chat-session'

export function botKickoffFingerprint(sessionId: string, kickoff = BOT_CREATED_KICKOFF): string {
  return agentSessionSendBodyFingerprint(sessionId, {
    ...botMessageBody(kickoff),
    origin: 'bot-created'
  })
}

/** True when the Chat holds Orca's kickoff and nothing that reached the agent from its owner, its turn
 *  has ended (or it was refused), and the bot said nothing. On its own Orca resends it once, only when
 *  the kickoff is all the Chat holds; the owner's Try again (`asked`) resends it whenever that holds. */
export function kickoffNeedsRetry(
  sessionId: string,
  { items, submissions }: Pick<AgentJournalSnapshot, 'items' | 'submissions'>,
  asked = false,
  kickoffText = BOT_CREATED_KICKOFF
): boolean {
  const kickoff = botKickoffFingerprint(sessionId, kickoffText)
  const kickoffs = submissions.filter((submission) => submission.payloadFingerprint === kickoff)
  // Anything the owner sent that reached the agent ends it; one its failed start refused never
  // did, so Try again still sends. Unasked, any other send ends it.
  if (
    kickoffs.length === 0 ||
    (!asked && submissions.length !== 1) ||
    submissions.some(
      (submission) =>
        submission.payloadFingerprint !== kickoff && submission.dispatchState !== 'rejected'
    )
  ) {
    return false
  }
  const turns = items.flatMap((item) => (item.body.kind === 'turn' ? [item.body] : []))
  const spoke = items.some((item) => item.body.kind === 'message' && item.body.role === 'assistant')
  // A kickoff still in flight, or accepted with its turn not open yet, is pending: not ended.
  const accepted = kickoffs.filter((submission) => submission.dispatchState === 'accepted')
  const inFlight = kickoffs.some(
    (submission) => submission.dispatchState === 'pending' || submission.dispatchState === 'unknown'
  )
  // Refused before a turn opened (its agent failed to start) ends it too.
  const refused = kickoffs.at(-1)?.dispatchState === 'rejected'
  const turnsEnded =
    turns.length > 0 &&
    turns.length >= accepted.length &&
    turns.every((turn) => turn.state !== 'running')
  return !inFlight && !spoke && (refused || turnsEnded)
}

// Two opens at once must not both send it.
const retrying = new Set<string>()

/** Sends the kickoff again when `kickoffNeedsRetry`; true when it did. */
export async function retryBotKickoff(
  bot: Pick<Bot, 'id' | 'name' | 'firstRun' | 'chatSessionId' | 'importedFrom' | 'sharedFrom'>,
  deps: {
    /** Each send's body fingerprint, read before any row. */
    fingerprints: (
      sessionId: string
    ) => Promise<readonly { clientMessageId: string; fingerprint: string }[]>
    /** The whole chat with these sends, read only once it holds nothing but kickoffs. */
    snapshot: (
      sessionId: string,
      sends: readonly string[]
    ) => Promise<Pick<AgentJournalSnapshot, 'items' | 'submissions'>>
    send: (botId: string) => Promise<unknown>
  },
  asked = false
): Promise<boolean> {
  if (!bot.firstRun || !bot.chatSessionId || retrying.has(bot.id)) {
    return false
  }
  retrying.add(bot.id)
  try {
    const kickoff = botFirstKickoff(bot)
    const sends = await deps.fingerprints(bot.chatSessionId)
    const fingerprint = botKickoffFingerprint(bot.chatSessionId, kickoff)
    // Asked, the owner's own sends are read too: one that never reached the agent leaves it unset.
    if (
      !sends.some((send) => send.fingerprint === fingerprint) ||
      (!asked && (sends.length !== 1 || sends[0].fingerprint !== fingerprint))
    ) {
      return false
    }
    const snapshot = await deps.snapshot(
      bot.chatSessionId,
      sends.map((send) => send.clientMessageId)
    )
    if (!kickoffNeedsRetry(bot.chatSessionId, snapshot, asked, kickoff)) {
      return false
    }
    await deps.send(bot.id)
    return true
  } finally {
    retrying.delete(bot.id)
  }
}
