import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  isAgentChatPermissionMode,
  publishedLegacyChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import { applyAllAgentsPermission } from '../../../shared/tui-agent-permission-choice'

/** Old dropdown writes use the replacement control's reset; an explicit typed write wins. */
export function legacyChatPermissionWrite(
  settings: GlobalSettings,
  updates: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const choice =
    'nativeChatPermissionMode' in updates && !('agentPermissionDefault' in updates)
      ? applyAllAgentsPermission(
          settings,
          isAgentChatPermissionMode(updates.nativeChatPermissionMode)
            ? updates.nativeChatPermissionMode
            : 'ask'
        )
      : {}
  return {
    ...choice,
    nativeChatPermissionMode: publishedLegacyChatPermissionMode({
      ...settings,
      ...updates,
      ...choice
    })
  }
}
