import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudeSession } from '../structured/claude-structured-session-state'
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
// for one. "Your Claude settings" has no mode to send, so that pick still starts a fresh agent.

export function requiresAcquisition(
  sessions: Sessions
): NonNullable<Adapter['permissionModeRequiresAcquisition']> {
  return (sessionId, mode) =>
    keptSession(sessions, sessionId) !== null && mode !== 'own' ? false : undefined
}

export function applyLive(
  sessions: Sessions,
  timeoutMs: () => number | undefined
): NonNullable<Adapter['applyPermissionMode']> {
  return async ({ sessionId, fence, mode }) => {
    const session = keptSession(sessions, sessionId)
    if (!session || session.fence !== fence || mode === 'own') {
      return
    }
    const claudeMode = claudePermissionModeFor(mode)
    // Plan stays until the user leaves it; leaving it returns to this mode.
    session.appliedInputOptions.set('buildPermissionMode', claudeMode)
    if (!claudeInPlan(session)) {
      await setClaudeAllowedPermissionMode(session, claudeMode, { timeoutMs: timeoutMs() })
    }
  }
}
