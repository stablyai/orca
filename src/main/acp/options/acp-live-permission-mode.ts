import {
  isAgentChatPermissionMode,
  type AgentChatPermissionChoice
} from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import { AcpAgentError } from '../transport/acp-errors'
import type { AcpOptionWriteBound } from './acp-session-option-write'

type LivePermissionSession = Pick<
  AcpStructuredSession,
  'spec' | 'connection' | 'options' | 'permissionModes' | 'permission' | 'launchArgsGrantFullAccess'
>

// Mode writes per running chat, in pick order, so an earlier pick never lands after a later one.
const modeWrites = new WeakMap<LivePermissionSession, Promise<void>>()
// Agents with an unanswered mode write: it may still land, so their mode stays unknown until a restart.
const unansweredModes = new WeakSet<object>()
// Kept agents that refused a mode write: their mode changes only by a restart from then on.
const refusedModes = new WeakSet<object>()

/** The choice the agent runs under now: Orca's own for requests it answers, else the agent's
 *  reported session mode; null when that mode is none of Orca's. */
export function acpRunningPermission(
  session: Pick<LivePermissionSession, 'spec' | 'options' | 'permissionModes' | 'permission'>
): AgentChatPermissionChoice | null {
  if (!session.spec.permissionModeConfig) {
    return session.permission
  }
  if (unansweredModes.has(session)) {
    return null
  }
  if (session.permission === 'own') {
    return 'own'
  }
  const reported = session.options.reportedPermissionMode(session.permissionModes)
  return isAgentChatPermissionMode(reported) ? reported : null
}

/** A kept agent the transition can switch to `mode` live (a write before the send), not by a restart. */
export function acpKeptModeTakesLive(
  session: LivePermissionSession,
  mode: AgentChatPermissionChoice
): boolean {
  const { kept } = session.connection
  if (
    !kept ||
    kept.agentExited ||
    mode === 'own' ||
    unansweredModes.has(session) ||
    refusedModes.has(session)
  ) {
    return false
  }
  return session.spec.permissionModeConfig
    ? session.permissionModes?.[mode] !== undefined
    : !session.launchArgsGrantFullAccess
}

/** Settles once every mode write already asked of this chat has been answered or given up. */
export function acpPermissionWritesSettled(session: LivePermissionSession): Promise<void> {
  return modeWrites.get(session) ?? Promise.resolve()
}

/** Moves a running chat to `mode` where the agent allows it; otherwise the next send restarts it. */
export function applyAcpLivePermissionMode(
  session: LivePermissionSession,
  mode: AgentChatPermissionChoice,
  bound: Pick<AcpOptionWriteBound, 'timeoutMs'>
): Promise<void> {
  if (!session.spec.permissionModeConfig) {
    // Orca answers this agent's permission requests, reading the mode at each request.
    if (!session.launchArgsGrantFullAccess) {
      session.permission = mode
      session.options.applied.set('permissionMode', mode === 'full-access' ? 'full-access' : 'ask')
    }
    return Promise.resolve()
  }
  const written = (modeWrites.get(session) ?? Promise.resolve()).then(() =>
    writeAcpSessionMode(session, mode, bound.timeoutMs)
  )
  modeWrites.set(
    session,
    written.catch(() => undefined)
  )
  return written
}

async function writeAcpSessionMode(
  session: LivePermissionSession,
  mode: AgentChatPermissionChoice,
  timeoutMs: number
): Promise<void> {
  // Own has no session mode to set, and a launch-granted mode has none either.
  const value = mode === 'own' ? undefined : session.permissionModes?.[mode]
  if (value === undefined || acpRunningPermission(session) === mode) {
    return
  }
  // Not the shared option writer: its revision would supersede a send's model or effort write.
  const reply = await session.connection
    .setConfigOption(session.options.modeConfigId(), value, undefined, undefined, timeoutMs)
    .catch((error: unknown) => {
      // Only the agent's refusal proves the mode held; otherwise the next send restarts the agent.
      if (!(error instanceof AcpAgentError)) {
        unansweredModes.add(session)
      } else if (session.connection.kept) {
        refusedModes.add(session)
      }
      throw error
    })
  session.options.adoptConfigOptions(reply.configOptions)
  session.permission = mode
}
