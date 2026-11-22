import { homedir } from 'node:os'
import { activeProviderContext } from '../../../../shared/agent-session/conversation-context/agent-session-provider-context'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionRefusalError,
  refuse
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import { resolveOmpSessionsDir } from '../../../ai-vault/scanners/omp/omp-session-root'
import { findOmpSessionByCwd } from '../../../omp/omp-session-cwd-lookup'

/** OMP is the first provider with a native stable branch we can derive without a finished reply. */
export const AUXILIARY_CHAT_PROVIDERS = ['omp'] as const

export type OmpAuxiliarySource = {
  sourcePath: string
  sourceNativeId: string
  workspaceCwd: string
  launchEnv: Record<string, string>
}

function launchEnvFor(
  resolved: Record<string, string> | undefined,
  accountHome: AgentSessionAccountHome
): Record<string, string> {
  return {
    ...resolved,
    ...(isLegacyAgentSessionAccountHome(accountHome)
      ? { [accountHome.variable]: accountHome.path }
      : {})
  }
}

/** Derive the parent's live provider conversation from its proven head, never from client input. */
export async function resolveOmpAuxiliarySource(
  host: StructuredAgentSessionHost,
  parent: AgentSessionRecord
): Promise<OmpAuxiliarySource> {
  if (parent.provider !== 'omp') {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  if (parent.auxiliaryChat) {
    throw refuse(
      'agent_session_operation_invalid',
      { reason: 'requestMalformed' },
      'An auxiliary chat cannot be the parent of another auxiliary chat.'
    )
  }
  const context = activeProviderContext(parent)
  const head = context.head
  if (!head) {
    throw refuse(
      'agent_session_operation_invalid',
      { reason: 'savedConversationMissing' },
      'This chat has no saved provider conversation to derive from. Send a message first.'
    )
  }
  if (context.pendingClear) {
    throw refuse(
      'agent_session_operation_invalid',
      { reason: 'conversationCleared' },
      'Finish the clear before starting an auxiliary chat.'
    )
  }
  if (
    head.handle.agent !== 'omp' ||
    head.handle.transport !== 'acp' ||
    (parent.lease.provenHandleLinkId !== null && parent.lease.provenHandleLinkId !== head.linkId)
  ) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const workspaceCwd =
    parent.launchDirectory ?? (await host.deps.resolveWorkspacePath?.(parent.location.workspaceId))
  if (!workspaceCwd) {
    throw refuse(
      'agent_session_operation_invalid',
      { reason: 'launchFolderMissing' },
      'This chat has no workspace folder to derive its context from.'
    )
  }
  const launchEnv = launchEnvFor(await host.deps.resolveLaunchEnv?.('omp'), parent.accountHome)
  const homeDir = launchEnv.USERPROFILE || launchEnv.HOME || homedir()
  const accountHomePath = isLegacyAgentSessionAccountHome(parent.accountHome)
    ? parent.accountHome.path
    : undefined
  const sessionsDir = resolveOmpSessionsDir({
    env: { ...launchEnv, ...(accountHomePath ? { PI_CODING_AGENT_DIR: accountHomePath } : {}) },
    homeDir
  })
  if (!sessionsDir) {
    throw refuse(
      'agent_session_identity_required',
      { reason: 'transcriptNotFound' },
      'This chat has no saved provider conversation to derive from.'
    )
  }
  const sourcePath = await findOmpSessionByCwd({
    sessionsDir,
    sessionId: head.handle.nativeId,
    cwd: workspaceCwd,
    homeDir,
    env: launchEnv,
    strictErrors: true
  })
  if (!sourcePath) {
    throw refuse(
      'agent_session_identity_required',
      { reason: 'transcriptNotFound' },
      'This chat has no saved provider conversation to derive from.'
    )
  }
  return {
    sourcePath,
    sourceNativeId: head.handle.nativeId,
    workspaceCwd,
    launchEnv
  }
}

/** `working` cuts the snapshot at the latest committed user input instead of the current streaming tail. */
export async function ompAuxiliaryParentWorking(
  host: StructuredAgentSessionHost,
  parent: AgentSessionRecord
): Promise<boolean> {
  const summary = host.readStatusSummary(parent.sessionId)
  const work = await host.currentWork(parent.sessionId).catch(() => null)
  return (
    parent.lastTurn?.state === 'open' ||
    summary?.status === 'working' ||
    summary?.status === 'attention' ||
    Boolean(work)
  )
}
