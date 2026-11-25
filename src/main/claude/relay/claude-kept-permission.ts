import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudeSession } from '../structured/claude-structured-session-state'
import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { claudePermissionModeFor } from '../structured/launch/claude-structured-permission-options'
import { claudeInPlan } from '../structured/permissions/claude-full-access-refusal'
import { claudeLeavingPlanOnApproval } from '../structured/permissions/claude-plan-approval-mode'
import {
  claimClaudePermissionModeRequest,
  claudeBypassRefusalOf,
  setClaudeAllowedPermissionMode
} from '../structured/permissions/claude-permission-mode-ladder'
import { keptClaudeAgentRelay } from './claude-kept-agent-connection'
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

/** Writes a Build mode. The pick is recorded before its write, so a message sent before Claude
 *  answers writes the same mode behind it; each write goes out at the pick, so Claude answers
 *  picks in order and the last one wins. A pick a newer one replaced records nothing after its
 *  answer; a failed switch leaves Ask owed to the next message. */
async function applyBuildMode(
  session: ClaudeSession,
  mode: PermissionMode,
  timeoutMs: number | undefined,
  current: () => boolean = () => true
): Promise<void> {
  // The chat now wants this mode from this process: messages, leaving Plan, a refused Full access
  // and the next reattach all read it, not the mode the agent was launched in.
  session.launchIntent = { ...session.launchIntent, permissionMode: mode }
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
    const applied = await setClaudeAllowedPermissionMode(session, mode, { timeoutMs })
    if (current()) {
      session.appliedInputOptions.set('buildPermissionMode', applied)
    }
  } catch (error) {
    if (current() && mode === 'bypassPermissions') {
      // Unknown or refused: the next message asks again (a refusal takes the fallback).
      session.appliedInputOptions.delete('buildPermissionMode')
    } else if (current()) {
      // Never back to an older, looser mode: Ask until the next message has it written.
      session.appliedInputOptions.set('buildPermissionMode', 'default')
      session.keptModeOwed = 'default'
    }
    throw error
  }
}

/** A live pick: auto-approval follows it at once (Claude's report of Full access grants it), and
 *  its write goes out now, ahead of any later pick's. */
function applyPick(
  session: ClaudeSession,
  mode: PermissionMode,
  timeoutMs: number | undefined
): Promise<void> {
  if (mode === 'bypassPermissions') {
    session.liveFullAccess?.picked()
  } else {
    session.liveFullAccess?.unpicked()
  }
  const turn = (session.keptModeTurn ?? 0) + 1
  session.keptModeTurn = turn
  return applyBuildMode(session, mode, timeoutMs, () => session.keptModeTurn === turn)
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
 *  still looked in Plan), so the latest goes out now, again until no newer pick arrived. */
export async function sendKeptPickMadeLeavingPlan(
  session: ClaudeSession,
  requested: PermissionMode,
  written: PermissionMode | null,
  timeoutMs: number | undefined
): Promise<PermissionMode | null> {
  let sent: string = requested
  let mode = written
  for (;;) {
    const latest = session.launchIntent?.permissionMode
    if (!keptClaudeAgentRelay(session.connection) || !isBuildMode(latest) || latest === sent) {
      return mode
    }
    sent = latest
    const ask =
      latest === 'bypassPermissions' ? askKeptBypassLeavingPlan(session, timeoutMs) : undefined
    if (ask) {
      await ask
    }
    mode = await setClaudeAllowedPermissionMode(session, latest, { timeoutMs })
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
    await applyPick(session, owed, timeoutMs)
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
    // Claude's own settings have no mode to send: after a live pick only a fresh agent has them.
    if (mode === 'own') {
      return session.keptModeTurn !== undefined ? true : undefined
    }
    return bypassRefused(session, mode)
  }
}

/** A pick saved while a kept agent reattaches is handed over at ready; until then, anything but
 *  Full access withdraws auto-approval at once, ahead of the requests the reattach releases. */
export function pickedWhileStarting(
  sessions: Sessions
): NonNullable<Adapter['permissionPickedWhileStarting']> {
  return ({ sessionId, mode }) =>
    keptSession(sessions, sessionId)?.liveFullAccess?.pickedWhileStarting(mode === 'full-access')
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
