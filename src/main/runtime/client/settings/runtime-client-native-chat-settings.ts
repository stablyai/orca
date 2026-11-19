import { publishedLegacyChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { nativeChatQueueFollowUps } from '../../../../shared/native-chat/input/composer/native-chat-follow-up-behavior'
import { nativeChatShowsCiResultLines } from '../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { nativeChatClaudeRemoteControl } from '../../../../shared/native-chat/settings/native-chat-claude-remote-control'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

/** This host's chat settings as a paired client reads them. */
export function runtimeClientNativeChatSettings(settings: ReturnType<RuntimeStore['getSettings']>) {
  return {
    nativeChatAutoContinueAfterUsageLimit: settings.nativeChatAutoContinueAfterUsageLimit === true,
    // Always present, so a client can tell this host accepts the setting (older hosts omit it).
    nativeChatClaudeRemoteControl: nativeChatClaudeRemoteControl(
      settings.nativeChatClaudeRemoteControl
    ),
    nativeChatPermissionMode: publishedLegacyChatPermissionMode(settings),
    // Mirror the host preference; delivery still depends on queue capability.
    nativeChatQueueFollowUps: nativeChatQueueFollowUps(settings),
    // Resolved, so a phone can tell a reported value from an older host's absence.
    nativeChatCiResultLines: nativeChatShowsCiResultLines(settings)
  }
}
