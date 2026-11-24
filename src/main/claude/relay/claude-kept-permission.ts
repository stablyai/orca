import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
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

const bypassRefused = (session: ClaudeSession, mode: AgentChatPermissionChoice): boolean =>
  mode === 'full-access' && session.bypassDisabled === true

/** Writes a Build mode and records the one Claude accepted; a failed switch records none. */
async function applyBuildMode(
  session: ClaudeSession,
  mode: PermissionMode,
  timeoutMs: number | undefined
): Promise<void> {
  if (claudeInPlan(session)) {
    // Plan stays until the user leaves it; leaving it returns to this mode.
    session.appliedInputOptions.set('buildPermissionMode', mode)
    return
  }
  try {
    const applied = await setClaudeAllowedPermissionMode(session, mode, { timeoutMs })
    session.appliedInputOptions.set('buildPermissionMode', applied)
  } catch (error) {
    session.appliedInputOptions.delete('buildPermissionMode')
    throw error
  }
}

/** At reattach: the agent runs the mode it had when the last app let go, which a pick made since
 *  may have changed, so the chat's own mode is written before anything is sent. */
export function applyKeptClaudeLaunchMode(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> {
  const wanted = session.launchIntent?.permissionMode
  if (wanted && session.savedPlan === true) {
    // Saved in Plan, so the agent may still be in it: leaving Plan writes this mode.
    session.appliedInputOptions.set('buildPermissionMode', wanted)
  }
  return wanted && session.savedPlan !== true
    ? applyBuildMode(session, wanted as PermissionMode, timeoutMs)
    : Promise.resolve()
}

export function requiresAcquisition(
  sessions: Sessions
): NonNullable<Adapter['permissionModeRequiresAcquisition']> {
  return (sessionId, mode) => {
    const session = keptSession(sessions, sessionId)
    if (!session || mode === 'own') {
      return undefined
    }
    return bypassRefused(session, mode)
  }
}

export function applyLive(
  sessions: Sessions,
  timeoutMs: () => number | undefined
): NonNullable<Adapter['applyPermissionMode']> {
  return async ({ sessionId, fence, mode }) => {
    const session = keptSession(sessions, sessionId)
    if (!session || session.fence !== fence || mode === 'own' || bypassRefused(session, mode)) {
      return
    }
    await applyBuildMode(session, claudePermissionModeFor(mode), timeoutMs())
  }
}
