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

export function classifyMobileNativeChatSend(
  agent: string | null,
  text: string,
  pickerSkillOriginToken: string | null = null
): NativeChatSendClassification {
  if (!agent) {
    return 'chat'
  }
  const profile = getNativeChatAgentProfile(agent)
  return classifyNativeChatSend(
    text,
    getMobileNativeChatCommands(agent),
    pickerSkillOriginToken,
    profile?.skillPrefix ?? null
  )
}
