import { parseNativeChatCommandEnvelope } from '../../../../shared/native-chat/transcript/messages/native-chat-command-envelope'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'

// These envelopes wrap what a lead agent asked for; the rest of the harness markup names nothing.
const MESSAGE_ENVELOPE = /^\s*<(teammate-message|agent-message)(?:\s[^>]*)?>([\s\S]*?)(?:<\/\1>|$)/

/** Stand-in title for a harness turn: a command as "/name args", or a teammate or agent message's body. */
export function claudeHarnessTurnTitle(text: string): string | null {
  const command = parseNativeChatCommandEnvelope(text)
  if (command) {
    return normalizeTitleText(command.args ? `${command.name} ${command.args}` : command.name)
  }
  const envelope = MESSAGE_ENVELOPE.exec(text)
  return envelope ? normalizeTitleText(envelope[2]) : null
}
