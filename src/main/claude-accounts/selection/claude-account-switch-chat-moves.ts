import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { moveStructuredAgentSessionChatsToSelectedAccount } from '../../native-chat/agent-session-wire/recovery/structured-agent-session-account-switch'

const NO_MOVES = Promise.resolve()

export function moveChatsAfterClaudeAccountSelection(
  readSettings: () => Pick<GlobalSettings, 'claudeAccountSwitchRunningSessions'>
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  const wanted = () => readSettings().claudeAccountSwitchRunningSessions === 'restart-all'
  return host && wanted()
    ? moveStructuredAgentSessionChatsToSelectedAccount(host, wanted)
    : NO_MOVES
}
