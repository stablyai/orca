import { getStructuredAgentSessionHost } from './structured-agent-session-registry'

export function hasLiveNativeChatTurns(): boolean {
  return getStructuredAgentSessionHost()?.deps.journalDatabase.activity.active === true
}
