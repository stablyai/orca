import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudeSession } from '../structured/claude-structured-session-state'
import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { claudePermissionModeFor } from '../structured/launch/claude-structured-permission-options'
import {
  claudeInPlan,
  claudeModeUnreported
} from '../structured/permissions/claude-full-access-refusal'
import { claudeLeavingPlanOnApproval } from '../structured/permissions/claude-plan-approval-mode'
import {
  claimClaudePermissionModeRequest,
  claudeBypassRefusalOf,
  setClaudeAllowedPermissionMode
} from '../structured/permissions/claude-permission-mode-ladder'
import { keptClaudeAgentRelay } from './claude-kept-agent-connection'
import {
  claudePermissionPickedWhileStarting,
  claudePermissionPickHolds,
  pickClaudePermissionMode,
  recordClaudeBuildMode
} from '../structured/permissions/claude-permission-picks'
import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { ClaudeControlRequestError } from '../sdk-transport/claude-agent-sdk-control-requests'

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
  // A newer write than any older ladder's: that ladder's late fallback stays unsent.
  claimClaudePermissionModeRequest(session)
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

/** A live pick, numbered by the chat's pick sequencer and recorded before its write, so a message
 *  sent before Claude answers writes the same mode behind it; each write goes out at the pick, so
 *  Claude answers picks in order and the last one wins. A pick a newer one replaced records
 *  nothing after its answer; a failed switch leaves Ask owed to the next message. */
async function applyPick(
  session: ClaudeSession,
  mode: PermissionMode,
  timeoutMs: number | undefined
): Promise<void> {
  // Messages, leaving Plan, a refused Full access and the next reattach all read the pick now.
  pickClaudePermissionMode(session, mode)
  const holds = claudePermissionPickHolds(session)
  session.appliedInputOptions.set('buildPermissionMode', mode)
  if (claudeInPlan(session) && !claudeLeavingPlanOnApproval(session)) {
    // Plan stays until the user leaves it; leaving it writes this mode. An approved plan's exit
    // in flight is already leaving Plan, so the pick goes out now behind it.
    return
  }
  try {
    if (mode === 'bypassPermissions') {
      await askKeptBypass(session, timeoutMs)
      return
    }
    recordClaudeBuildMode(
      session,
      holds,
      await setClaudeAllowedPermissionMode(session, mode, { timeoutMs })
    )
  } catch (error) {
    if (holds() && mode === 'bypassPermissions') {
      // Unknown or refused: the next message asks again (a refusal takes the fallback).
      session.appliedInputOptions.delete('buildPermissionMode')
    } else if (holds()) {
      // Never back to an older, looser mode: Ask until the next message has it written.
      session.appliedInputOptions.set('buildPermissionMode', 'default')
      session.keptModeOwed = 'default'
    }
    throw error
  }
}

/** Full access picked in Plan wasn't asked of Claude (asking leaves Plan), so leaving Plan asks it
 *  first; otherwise an Ask launch's first init reads as a refusal and the ladder never tries it. */
export function askKeptBypassLeavingPlan(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> | undefined {
  // Written now (not after a tick), so it goes out ahead of whatever the caller writes next.
  return keptClaudeAgentRelay(session.connection) &&
    session.launchIntent?.permissionMode === 'bypassPermissions' &&
    session.bypassAccepted !== true &&
    session.bypassDisabled !== true
    ? askKeptBypass(session, timeoutMs).catch(() => {})
    : undefined
}

/** A kept agent's picks made while a message took it out of Plan were only recorded (the chat
 *  still looked in Plan), so the latest goes out now, again until no newer pick arrived. Returns
 *  Claude's last answer with the check that its pick is still the latest. */
export async function sendKeptPickMadeLeavingPlan(
  session: ClaudeSession,
  written: PermissionMode | null,
  holds: () => boolean,
  timeoutMs: number | undefined
): Promise<{ mode: PermissionMode | null; holds: () => boolean }> {
  let mode = written
  let current = holds
  for (;;) {
    const latest = session.launchIntent?.permissionMode
    if (current() || !keptClaudeAgentRelay(session.connection) || !isBuildMode(latest)) {
      return { mode, holds: current }
    }
    current = claudePermissionPickHolds(session)
    const ask =
      latest === 'bypassPermissions' ? askKeptBypassLeavingPlan(session, timeoutMs) : undefined
    if (ask) {
      await ask
    }
    // A newer pick while Claude answered goes out next, not this one again.
    if (current()) {
      mode = await setClaudeAllowedPermissionMode(session, latest, { timeoutMs })
    }
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

/** Before a kept agent's message: its owed mode, kept owed until written (a failed write owes Ask
 *  and throws, so no message goes out looser than picked; only Full access may lag), except in
 *  Plan, which leaving writes. The chat's saved Plan stands in for the mode only until
 *  Claude reports one, so a stale launch-time Plan never drops an owed Ask. */
export async function applyKeptClaudeModeOwed(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> {
  const owed = session.keptModeOwed
  if (!isBuildMode(owed)) {
    session.keptModeOwed = undefined
    return
  }
  if (claudeInPlan(session) || (session.savedPlan === true && claudeModeUnreported(session))) {
    return
  }
  try {
    await applyPick(session, owed, timeoutMs)
  } catch (error) {
    if (owed !== 'bypassPermissions') {
      throw error
    }
  }
  if (session.keptModeOwed === owed) {
    session.keptModeOwed = undefined
  }
}

export function requiresAcquisition(
  sessions: Sessions
): NonNullable<Adapter['permissionModeRequiresAcquisition']> {
  return (sessionId, mode) => {
    const session = keptSession(sessions, sessionId)
    if (!session) {
      return undefined
    }
    // Claude's own settings have no mode to send: only an agent launched on them and still in the
    // mode they gave it has them; any other (a live pick, an earlier app's launch) is replaced.
    if (mode === 'own') {
      const own =
        session.permissionPick === undefined &&
        keptClaudeAgentRelay(session.connection)?.ownSettings
      return own ? undefined : true
    }
    return bypassRefused(session, mode)
  }
}

/** See `StructuredAgentSessionAdapter.keptLaunchOutgrown`: a kept agent the launch's tools outgrew
 *  is replaced, like a tools change, only once it owes no work and its replay is durable. */
export function launchOutgrown(sessions: Sessions): NonNullable<Adapter['keptLaunchOutgrown']> {
  return async (sessionId, toolsOutdated, owesWork) => {
    const session = keptSession(sessions, sessionId)
    const relay = session ? keptClaudeAgentRelay(session.connection) : null
    return relay?.launchOutgrown(toolsOutdated, owesWork)
  }
}

/** A pick saved while a kept agent reattaches is handed over at ready; until then, anything but
 *  Full access withdraws auto-approval at once, ahead of the requests the reattach releases. */
export function pickedWhileStarting(
  sessions: Sessions
): NonNullable<Adapter['permissionPickedWhileStarting']> {
  return ({ sessionId, mode }) =>
    claudePermissionPickedWhileStarting(
      keptSession(sessions, sessionId) ?? {},
      mode === 'full-access'
    )
}

const CHOICE_OF_MODE: Readonly<Record<string, AgentChatPermissionChoice>> = {
  default: 'ask',
  acceptEdits: 'accept-edits',
  auto: 'auto',
  bypassPermissions: 'full-access'
}

/** A kept agent takes picks live, so the mode it runs is its latest applied pick, not its launch. */
export function runningMode(sessions: Sessions): NonNullable<Adapter['runningPermissionMode']> {
  return (sessionId) => {
    const session = keptSession(sessions, sessionId)
    const applied = session?.appliedInputOptions.get('buildPermissionMode')
    return applied === undefined ? undefined : CHOICE_OF_MODE[applied]
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
    await applyPick(session, claudePermissionModeFor(mode), timeoutMs())
  }
}

/** A kept agent may run an older CLI than the installed one the capability check read: once it
 *  refuses the flag-settings control, it runs on its own choices and the message still goes. */
export function keptCliRefusedFlagSettings(session: ClaudeSession, error: unknown): void {
  // Refused once (the effort write), the CLI's local check refuses the rest of this message too.
  const refused =
    session.flagSettingsControl === 'unsupported' ||
    (error instanceof AgentSessionOptionRejectedError &&
      error.cause instanceof ClaudeControlRequestError)
  if (!refused || !keptClaudeAgentRelay(session.connection)) {
    throw error
  }
  session.flagSettingsControl = 'unsupported'
}
