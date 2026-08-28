// Mobile counterpart of desktop's send classification gate
// (src/renderer/src/components/native-chat/NativeChatComposer.tsx): slash/skill
// sends are TUI control actions, not chat turns — they never echo as a user
// bubble, because the transcript will never contain a matching user turn and
// the optimistic echo would never reconcile.

import {
  getNativeChatAgentProfile,
  getVerifiedNativeChatCommands
} from '../../../src/shared/native-chat-agent-profiles'
import {
  classifyNativeChatSend,
  nativeChatSlashCommandOpensAgentPicker,
  type NativeChatSendClassification
} from '../../../src/shared/native-chat-slash-commands'

export type { NativeChatSendClassification }

/** Classify a mobile chat send for the tab's agent. Mobile has no skill picker,
 *  so there is never a picker-origin token that reclassifies a `/token` as chat. */
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
    getVerifiedNativeChatCommands(agent),
    null,
    profile?.skillPrefix ?? null
  )
}

/** Whether this send dispatches a command the agent answers with its own TUI
 *  picker (`/resume`). Mobile's chat view cannot render one, so the caller has to
 *  bring the terminal view forward — otherwise the command looks like it did
 *  nothing at all (STA-4617). */
export function mobileNativeChatSendOpensAgentPicker(agent: string | null, text: string): boolean {
  if (!agent) {
    return false
  }
  return nativeChatSlashCommandOpensAgentPicker(text, getVerifiedNativeChatCommands(agent))
}
