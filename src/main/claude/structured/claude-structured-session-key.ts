import { forgetClaudePaneAccount } from '../../claude-accounts/claude-pane-account-registry'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/agent-session/view/structured-agent-session-projection'

/** Registry and hook-status key for one native-chat Claude session. */
export function structuredClaudeSessionKey(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}

/** A proved close forgets the chat's pane record; a crash re-acquires the session and keeps it. */
export function forgetStructuredClaudeSession(sessionId: string): void {
  forgetClaudePaneAccount(structuredClaudeSessionKey(sessionId))
}
