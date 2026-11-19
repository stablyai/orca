import type { AgentSessionProviderRemoteControlChoice } from '../../../../shared/agent-session/remote-control/agent-session-provider-remote-control'
import type { NativeChatClaudeRemoteControl } from '../../../../shared/native-chat/settings/native-chat-claude-remote-control'
import type { ClaudeRemoteControlEvent } from './claude-remote-control-machine'

/** Claude Code's own "Remote Control for all sessions" as the CLI resolved it at initialize. */
export type ClaudeRemoteControlDefault = { enabled: boolean; byDefault: boolean }

/** The chat's saved choice outranks Orca's setting, which outranks Claude Code's own. */
export function claudeRemoteControlAtStart(input: {
  choice: AgentSessionProviderRemoteControlChoice | undefined
  setting: NativeChatClaudeRemoteControl
  claude: ClaudeRemoteControlDefault
}): Extract<ClaudeRemoteControlEvent, { type: 'connect' }> | null {
  const decided = input.choice ?? (input.setting === 'claude-code' ? null : input.setting)
  if (decided) {
    return decided === 'on' ? { type: 'connect', enabledByDefault: false } : null
  }
  return input.claude.enabled ? { type: 'connect', enabledByDefault: input.claude.byDefault } : null
}
