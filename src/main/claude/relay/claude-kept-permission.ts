import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudeSession } from '../structured/claude-structured-session-state'
import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { claudePermissionModeFor } from '../structured/launch/claude-structured-permission-options'
import { claudeInPlan } from '../structured/permissions/claude-full-access-refusal'
import {
  claudeBypassRefusalOf,
  setClaudeAllowedPermissionMode
} from '../structured/permissions/claude-permission-mode-ladder'
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

const BUILD_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'auto'
])
const isBuildMode = (mode: string | undefined): mode is PermissionMode =>
  mode !== undefined && BUILD_MODES.has(mode)

const bypassRefused = (session: ClaudeSession, mode: AgentChatPermissionChoice): boolean =>
  mode === 'full-access' && session.bypassDisabled === true

/** Only Claude knows whether this process was launched able to bypass: asked straight, not through
 *  the ladder (which reads an Ask launch's first init as a refusal). A refusal makes the next send
 *  start a flagged agent; acceptance proves Full access for this process. */
async function askKeptBypass(session: ClaudeSession, timeoutMs: number | undefined): Promise<void> {
  try {
    await session.connection.setPermissionMode('bypassPermissions', { timeoutMs })
    session.bypassAccepted = true
    session.bypassDisabled = false
    session.bypassRefusal = undefined
  } catch (error) {
    const refusal = claudeBypassRefusalOf(error)
    if (refusal === null) {
      throw error
    }
    session.bypassDisabled = true
    session.bypassRefusal = refusal
    throw error
  }
}

/** Writes a Build mode and records the one Claude accepted; a failed switch records none. */
async function applyBuildMode(
  session: ClaudeSession,
  mode: PermissionMode,
  timeoutMs: number | undefined
): Promise<void> {
  if (mode === 'bypassPermissions' && !claudeInPlan(session)) {
    await askKeptBypass(session, timeoutMs)
  }
  // The chat now wants this mode from this process: leaving Plan, a refused Full access and the
  // next reattach all read it, not the mode the agent was launched in.
  session.launchIntent = { ...session.launchIntent, permissionMode: mode }
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

/** Picks run without waiting on each other; each writes after the one before it, so the last
 *  pick is the mode Claude ends in, and a pick a newer one already replaced writes nothing. */
function applyInOrder(
  session: ClaudeSession,
  mode: PermissionMode,
  timeoutMs: number | undefined
): Promise<void> {
  const turn = (session.keptModeTurn ?? 0) + 1
  session.keptModeTurn = turn
  const run = (session.keptModeWrites ?? Promise.resolve())
    .catch(() => {})
    .then(() =>
      session.keptModeTurn === turn ? applyBuildMode(session, mode, timeoutMs) : undefined
    )
  session.keptModeWrites = run
  return run
}

/** Full access picked in Plan wasn't asked of Claude (asking leaves Plan), so leaving Plan asks it
 *  first; otherwise an Ask launch's first init reads as a refusal and the ladder never tries it. */
export async function askKeptBypassLeavingPlan(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> {
  if (
    keptClaudeAgentRelay(session.connection) &&
    session.launchIntent?.permissionMode === 'bypassPermissions' &&
    session.bypassAccepted !== true &&
    session.bypassDisabled !== true
  ) {
    await askKeptBypass(session, timeoutMs).catch(() => {})
  }
}

/** At reattach the agent runs what it had when the last app let go, which a pick made since may
 *  have changed. Like the open app, the chat's mode and choices go with its next message: by then
 *  the replay has shown whether the agent is in Plan. The launch-seeded choices are forgotten, so
 *  that message writes them. */
export function noteKeptClaudeReattach(session: ClaudeSession): void {
  for (const key of ['model', 'effort', 'fastMode']) {
    session.appliedInputOptions.delete(key)
  }
  const launched = session.launchIntent?.permissionMode
  if (!isBuildMode(launched)) {
    return
  }
  session.appliedInputOptions.set('buildPermissionMode', launched)
  session.keptModeOwed = launched
}

/** Before a kept agent's first message: its owed mode, unless it is in Plan (leaving Plan writes it). */
export async function applyKeptClaudeModeOwed(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> {
  const owed = session.keptModeOwed
  session.keptModeOwed = undefined
  if (isBuildMode(owed) && !claudeInPlan(session) && session.savedPlan !== true) {
    await applyInOrder(session, owed, timeoutMs)
  }
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
    if (!session || session.fence !== fence) {
      return
    }
    // A newer pick replaces what the reattach owed the next message.
    session.keptModeOwed = undefined
    if (mode === 'own' || bypassRefused(session, mode)) {
      return
    }
    await applyInOrder(session, claudePermissionModeFor(mode), timeoutMs())
  }
}
