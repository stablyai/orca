import { agentMessageSenderName } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { parseBotAvatar } from '../../../../../shared/bot-avatar'
import type { PeerMailSender } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'

/** The card's sender for mail from a paired Orca, kept on the message: its label is the party, named by
 *  what that Orca sent. Display only; the sender's fields grant nothing here. */
export function peerMailSenderSnapshot(
  label: string,
  sender: PeerMailSender | undefined
): string | undefined {
  if (!sender) {
    return undefined
  }
  const host = agentMessageSenderName(sender.computer)
  return JSON.stringify({
    version: 1,
    sender: {
      party: { address: label, terminalHandle: null, orcaSessionId: null },
      name: agentMessageSenderName(sender.bot?.name ?? sender.name ?? label),
      ...(sender.agent ? { agent: sender.agent } : {}),
      ...(sender.bot ? { bot: true } : {}),
      ...(portableAvatar(sender.bot?.avatar) ? { botAvatar: sender.bot?.avatar } : {}),
      ...(host ? { host } : {})
    }
  })
}

const EMOJI = /^\p{Extended_Pictographic}/u

/** A mascot or emoji draws anywhere; an upload lives on the bot's own computer, so its initial shows. */
function portableAvatar(avatar: string | null | undefined): boolean {
  const parsed = parseBotAvatar(avatar ?? null)
  return (
    parsed?.kind === 'mascot' ||
    (parsed?.kind === 'emoji' && EMOJI.test(parsed.emoji) && parsed.emoji.length <= 16)
  )
}
