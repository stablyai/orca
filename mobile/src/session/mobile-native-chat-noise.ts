import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { isKnownHarnessInjectedUserTurnText } from '../../../src/shared/harness-injected-user-turns'

// Why: the harness injects machinery into the agent's conversation as user-role
// turns — task notifications, system reminders, inter-agent messages, slash-command
// envelopes, local-command output, interruption/compaction notices. These land in
// the transcript but are not real user messages, so the chat filters them out (they
// were confusingly rendered as the user's own bubbles). The tag/prefix classifier
// is shared with desktop and the agent-status prompt pipeline.

function messageText(message: NativeChatMessage): string {
  return message.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim()
}

/** True when a message is harness machinery rather than real conversation. Only
 *  user/system turns qualify — assistant/tool turns and any turn carrying real
 *  tool activity are always kept. */
export function isNoiseMessage(message: NativeChatMessage): boolean {
  if (message.role !== 'user' && message.role !== 'system') {
    return false
  }
  // Keep turns that carry tool activity (e.g. a user turn with tool results).
  if (message.blocks.some((b) => b.type === 'tool-call' || b.type === 'tool-result')) {
    return false
  }
  return isKnownHarnessInjectedUserTurnText(messageText(message))
}

/** Drop harness-noise messages from a transcript. */
export function stripNoiseMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  return messages.filter((m) => !isNoiseMessage(m))
}
