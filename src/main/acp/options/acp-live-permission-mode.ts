import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import { AcpAgentError } from '../transport/acp-errors'
import type { AcpOptionWriteBound } from './acp-session-option-write'

type LivePermissionSession = Pick<
  AcpStructuredSession,
  'spec' | 'connection' | 'options' | 'permissionModes' | 'permission' | 'launchArgsGrantFullAccess'
>

// Mode writes per running chat, in pick order, so an earlier pick never lands after a later one.
const modeWrites = new WeakMap<LivePermissionSession, Promise<void>>()

/** Moves a running chat to `mode` where the agent allows it; otherwise the next send restarts it. */
export function applyAcpLivePermissionMode(
  session: LivePermissionSession,
  mode: AgentChatPermissionChoice,
  bound: AcpOptionWriteBound
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
    writeAcpSessionMode(session, mode, bound)
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
  bound: AcpOptionWriteBound
): Promise<void> {
  // Own has no session mode to set, and a launch-granted mode has none either.
  const value = mode === 'own' ? undefined : session.permissionModes?.[mode]
  if (session.permission === mode || value === undefined) {
    return
  }
  // Not the shared option writer: its revision would supersede a send's model or effort write.
  const reply = await session.connection
    .setConfigOption(session.options.modeConfigId(), value, undefined, undefined, bound.timeoutMs)
    .catch((error: unknown) => {
      // Only the agent's own refusal proves its mode did not change.
      if (!(error instanceof AcpAgentError)) {
        bound.onUncertain?.(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    })
  session.options.adoptConfigOptions(reply.configOptions)
  if (session.options.reportedPermissionMode(session.permissionModes) === mode) {
    session.permission = mode
  }
}
