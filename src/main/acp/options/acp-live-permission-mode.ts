import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import { writeAcpSessionOption, type AcpOptionWriteBound } from './acp-session-option-write'

/** Moves a running chat to `mode` where the agent allows it; otherwise the next send restarts it. */
export async function applyAcpLivePermissionMode(
  session: Pick<
    AcpStructuredSession,
    | 'spec'
    | 'connection'
    | 'options'
    | 'permissionModes'
    | 'permission'
    | 'launchArgsGrantFullAccess'
  >,
  mode: AgentChatPermissionChoice,
  bound: AcpOptionWriteBound
): Promise<void> {
  if (session.permission === mode) {
    return
  }
  if (!session.spec.permissionModeConfig) {
    // Orca answers this agent's permission requests, reading the mode at each request.
    if (!session.launchArgsGrantFullAccess) {
      session.permission = mode
      session.options.applied.set('permissionMode', mode === 'full-access' ? 'full-access' : 'ask')
    }
    return
  }
  // Own has no session mode to set, and a launch-granted mode has none either.
  const value = mode === 'own' ? undefined : session.permissionModes?.[mode]
  if (value === undefined) {
    return
  }
  const write = { method: 'config' as const, configId: session.options.modeConfigId(), value }
  await writeAcpSessionOption(session.connection, session.options, write, {
    ...bound,
    key: 'permissionMode',
    value
  })
  if (session.options.reportedPermissionMode(session.permissionModes) === mode) {
    session.permission = mode
  }
}
