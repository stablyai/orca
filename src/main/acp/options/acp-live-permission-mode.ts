import {
  isAgentChatPermissionMode,
  type AgentChatPermissionChoice
} from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import type { AcpOptionWriteBound } from './acp-session-option-write'

type LivePermissionSession = Pick<
  AcpStructuredSession,
  'spec' | 'connection' | 'options' | 'permissionModes' | 'permission' | 'launchArgsGrantFullAccess'
>

// Mode writes per running chat, in pick order, so an earlier pick never lands after a later one.
const modeWrites = new WeakMap<LivePermissionSession, Promise<void>>()

/** The choice the agent runs under now: Orca's own for requests it answers, else the agent's
 *  reported session mode; null when that mode is none of Orca's. */
export function acpRunningPermission(
  session: Pick<LivePermissionSession, 'spec' | 'options' | 'permissionModes' | 'permission'>
): AgentChatPermissionChoice | null {
  if (!session.spec.permissionModeConfig || session.permission === 'own') {
    return session.permission
  }
  const reported = session.options.reportedPermissionMode(session.permissionModes)
  return isAgentChatPermissionMode(reported) ? reported : null
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
  // An unanswered write leaves the reported mode unchanged, so the next send restarts the agent.
  const reply = await session.connection.setConfigOption(
    session.options.modeConfigId(),
    value,
    undefined,
    undefined,
    timeoutMs
  )
  session.options.adoptConfigOptions(reply.configOptions)
  session.permission = mode
}
