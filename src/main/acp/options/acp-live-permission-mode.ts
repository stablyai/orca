import {
  isAgentChatPermissionMode,
  type AgentChatPermissionChoice
} from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  acpAnswersRequests,
  confirmAcpPermissionModeWrite
} from '../launch/acp-launch-permission-modes'
import type { RequestPermissionRequest } from '../generated/acp-protocol.generated'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import { AcpAgentError } from '../transport/acp-errors'
import type { AcpOptionWriteBound } from './acp-session-option-write'

type LivePermissionSession = Pick<
  AcpStructuredSession,
  'spec' | 'connection' | 'options' | 'permissionModes' | 'permission' | 'launchArgsGrantFullAccess'
>

type PermissionCheckSession = Pick<
  LivePermissionSession,
  'spec' | 'options' | 'permissionModes' | 'permission'
>

// Mode writes per running chat, in pick order, so an earlier pick never lands after a later one.
const modeWrites = new WeakMap<LivePermissionSession, Promise<void>>()
// Agents with an unanswered mode write: it may still land, so their mode stays unknown until a restart.
const unansweredModes = new WeakSet<PermissionCheckSession>()
// Count of in-flight permission mode writes per session; while > 0, never auto-approve permissions.
const pendingModeWrites = new WeakMap<PermissionCheckSession, number>()

function acpPermissionWriteInFlight(session: PermissionCheckSession): boolean {
  return (pendingModeWrites.get(session) ?? 0) > 0
}

/** Auto-approves a permission request only when the live confirmed mode is full-access and idle. */
export function acpAutoApprovePermission(
  session: Pick<LivePermissionSession, 'spec' | 'options' | 'permissionModes' | 'permission'>,
  request: RequestPermissionRequest
): { outcome: { outcome: 'selected'; optionId: string } } | null {
  const claimed = session.spec.dialect.request?.('session/request_permission', request)
  if (
    acpPermissionWriteInFlight(session) ||
    acpRunningPermission(session) !== 'full-access' ||
    !acpAnswersRequests(session.spec) ||
    claimed
  ) {
    return null
  }
  const allow = request.options.find((option) => option.kind === 'allow_once')
  return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : null
}

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
  const reported = session.options.reportedPermissionMode(
    session.permissionModes,
    session.spec.permissionModeConfig?.configId
  )
  return isAgentChatPermissionMode(reported) ? reported : null
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
  if (value === undefined) {
    return
  }
  if (acpRunningPermission(session) === mode) {
    session.permission = mode
    return
  }
  // Not the shared option writer: its revision would supersede a send's model or effort write.
  const config = session.spec.permissionModeConfig
  const configId = session.options.modeConfigId(config?.configId)
  pendingModeWrites.set(session, (pendingModeWrites.get(session) ?? 0) + 1)
  let answered = false
  try {
    await session.connection
      .setConfigOption(
        configId,
        value,
        undefined,
        ({ configOptions }) => {
          answered = true
          // The agent accepted the RPC and moved off 'own'; clear 'own' before reading
          // `acpRunningPermission` so an unconfirmed reply never leaves 'own' stuck.
          if (session.permission === 'own') {
            session.permission = 'ask'
          }
          if (config) {
            try {
              confirmAcpPermissionModeWrite(config, configId, value, configOptions, session.options)
            } catch (error) {
              const actual = acpRunningPermission(session)
              if (actual && actual !== 'own') {
                session.permission = actual
              }
              throw error
            }
          } else {
            session.options.adoptConfigOptions(configOptions)
          }
          session.permission = mode
        },
        timeoutMs
      )
      .catch((error: unknown) => {
        // Only an unanswered write leaves the mode unknown; confirmation errors after a reply keep
        // the options state updated synchronously inside `received` before any trailing updates.
        if (!answered && !(error instanceof AcpAgentError)) {
          unansweredModes.add(session)
        }
        throw error
      })
    if (config) {
      session.permission = acpRunningPermission(session) ?? mode
    }
  } finally {
    const remaining = (pendingModeWrites.get(session) ?? 1) - 1
    if (remaining <= 0) {
      pendingModeWrites.delete(session)
    } else {
      pendingModeWrites.set(session, remaining)
    }
  }
}
