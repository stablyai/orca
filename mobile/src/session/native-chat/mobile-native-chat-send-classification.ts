// Do not echo terminal slash/skill controls as chat turns: no transcript user row exists to reconcile their bubbles.

import {
  getAgentAnsweredNativeChatCommands,
  getNativeChatAgentProfile
} from '../../../../src/shared/native-chat-agent-profiles'
import {
  classifyNativeChatSend,
  type NativeChatSendClassification,
  type SlashCommandSuggestion
} from '../../../../src/shared/native-chat/input/native-chat-slash-commands'

// Terminal mobile chat lacks desktop-owned command answers and reply rows.
export function getMobileNativeChatCommands(agent: string): readonly SlashCommandSuggestion[] {
  return getAgentAnsweredNativeChatCommands(agent)
}

// Terminal sends carry no picker-origin override that could reclassify a slash token as chat.
export function classifyMobileNativeChatSend(
  agent: string | null,
  text: string
): NativeChatSendClassification {
  if (!agent) {
    return 'chat'
  }
  const profile = getNativeChatAgentProfile(agent)
  return classifyNativeChatSend(
    text,
    getMobileNativeChatCommands(agent),
    null,
    profile?.skillPrefix ?? null
  )
}
