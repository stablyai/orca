import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudeSession } from '../structured/claude-structured-session-state'
import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { claudePermissionModeFor } from '../structured/launch/claude-structured-permission-options'
import { claudeInPlan } from '../structured/permissions/claude-full-access-refusal'
import { setClaudeAllowedPermissionMode } from '../structured/permissions/claude-permission-mode-ladder'
import { keptClaudeAgentRelay } from './claude-kept-agent-connection'

type Adapter = StructuredAgentSessionAdapter
type Sessions = ReadonlyMap<string, ClaudeSession>

function keptSession(sessions: Sessions, sessionId: string): ClaudeSession | null {
  const session = sessions.get(sessionId)
  return session && keptClaudeAgentRelay(session.connection) ? session : null
}

// A kept agent takes a permission pick live, the way it takes a model pick: it is never replaced
// for one. Two picks it can't take still start a fresh agent: "your Claude settings" (no mode to
// send), and Full access once Claude refused bypass (only a flagged launch allows it).

function takesLive(session: ClaudeSession, mode: AgentChatPermissionChoice): boolean {
  return mode !== 'own' && !(mode === 'full-access' && session.bypassDisabled === true)
}

export function requiresAcquisition(
  sessions: Sessions
): NonNullable<Adapter['permissionModeRequiresAcquisition']> {
  return (sessionId, mode) => {
    const session = keptSession(sessions, sessionId)
    return session && takesLive(session, mode) ? false : undefined
  }
}

export function applyLive(
  sessions: Sessions,
  timeoutMs: () => number | undefined
): NonNullable<Adapter['applyPermissionMode']> {
  return async ({ sessionId, fence, mode }) => {
    const session = keptSession(sessions, sessionId)
    if (!session || session.fence !== fence || mode === 'own' || !takesLive(session, mode)) {
      return
    }
    const claudeMode = claudePermissionModeFor(mode)
    // Plan stays until the user leaves it; leaving it returns to this mode.
    const applied = claudeInPlan(session)
      ? claudeMode
      : await setClaudeAllowedPermissionMode(session, claudeMode, { timeoutMs: timeoutMs() })
    session.appliedInputOptions.set('buildPermissionMode', applied)
  }
}
