import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatLaunchPermissionMode,
  type AgentChatPermissionMode
} from '../../shared/agent-chat-permission-mode'

export function agentChatPermissionModeForSettings(
  agent: TuiAgent,
  settings: Partial<Pick<GlobalSettings, 'nativeChatPermissionMode'>> | null | undefined
): AgentChatPermissionMode {
  return agentChatLaunchPermissionMode(agent, null, settings?.nativeChatPermissionMode)
}

/** Persist a new chat's initial intent before any provider startup. */
export function withAgentChatPermissionSeed(
  agent: TuiAgent,
  settings: Partial<Pick<GlobalSettings, 'nativeChatPermissionMode'>>,
  seeded: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (agent !== 'claude' && agent !== 'codex') {
    return seeded
  }
  const permissionMode = agentChatPermissionModeForSettings(agent, settings)
  return { ...seeded, [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permissionMode }
}
