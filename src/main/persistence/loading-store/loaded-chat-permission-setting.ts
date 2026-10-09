import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  agentChatPermissionModeFromSetting,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import { resolveAgentPermissionModeSummary } from '../../../shared/tui-agent-permissions'

export function loadedChatPermissionSetting(
  saved: unknown,
  terminal: Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>,
  markNeedsSave: () => void
): AgentChatPermissionMode {
  const mode =
    saved === undefined
      ? resolveAgentPermissionModeSummary(terminal) === 'yolo'
        ? 'bypass'
        : 'ask'
      : agentChatPermissionModeFromSetting(saved)
  if (saved !== mode) {
    markNeedsSave()
  }
  return mode
}
