import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../src/shared/agent-session-resume'
import type { TuiAgent } from '../../../src/shared/types'
import { AI_VAULT_HOST_AUTHORITY_RESUME_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'
import type { MobileReviewTerminalTab } from './mobile-diff-review-rpc'

export const MOBILE_AI_VAULT_HOST_AUTHORITY_RESUME_CAPABILITY =
  AI_VAULT_HOST_AUTHORITY_RESUME_RUNTIME_CAPABILITY

type HostAuthorityResumeLaunch = {
  launchAgent?: TuiAgent
  providerSession?: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
  startupCwd?: string
  hostAuthorityEligible?: boolean
}

export async function tryHostAuthorityAiVaultResume(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  launch: HostAuthorityResumeLaunch,
  hostCapabilities: readonly string[] | undefined
): Promise<MobileReviewTerminalTab | null> {
  if (
    !launch.launchAgent ||
    !launch.providerSession ||
    launch.hostAuthorityEligible === false ||
    !hostCapabilities?.includes(MOBILE_AI_VAULT_HOST_AUTHORITY_RESUME_CAPABILITY)
  ) {
    return null
  }
  const ensured = await client.sendRequest(
    'terminal.ensureAgentSession',
    {
      kind: 'explicit',
      worktree: `id:${worktreeId}`,
      agent: launch.launchAgent,
      providerSession: launch.providerSession,
      ...(launch.startupCwd ? { startupCwd: launch.startupCwd } : {}),
      ...(launch.launchConfig?.ompResumeFilePath
        ? { ompResumeFilePath: launch.launchConfig.ompResumeFilePath }
        : {}),
      ...(launch.launchConfig?.agentArgs !== undefined
        ? { agentArgs: launch.launchConfig.agentArgs }
        : {}),
      presentation: 'background'
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!ensured.ok) {
    if (
      ensured.error?.code === 'agent_session_legacy_required' ||
      ensured.error?.code === 'method_not_found'
    ) {
      // Why: these errors prove launch made no side effect, so legacy fallback
      // cannot duplicate an already-running provider session.
      return null
    }
    throw new Error(ensured.error?.message || 'Failed to resume agent session')
  }
  const terminal = readEnsuredTerminal(ensured.result)
  if (!terminal) {
    throw new Error('Ensured terminal response was invalid')
  }
  const activated = await client.sendRequest(
    'session.tabs.activate',
    {
      worktree: `id:${worktreeId}`,
      tabId: terminal.id,
      notifyClients: false,
      navigation: 'caller'
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!activated.ok) {
    throw new Error(activated.error?.message || 'Failed to activate resumed terminal')
  }
  return terminal
}

function readEnsuredTerminal(value: unknown): MobileReviewTerminalTab | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const terminal = (value as { terminal?: unknown }).terminal
  if (!terminal || typeof terminal !== 'object') {
    return null
  }
  const record = terminal as { handle?: unknown; tabId?: unknown; title?: unknown }
  if (typeof record.handle !== 'string' || typeof record.tabId !== 'string') {
    return null
  }
  return {
    id: record.tabId,
    terminal: record.handle,
    title: typeof record.title === 'string' && record.title ? record.title : 'Terminal'
  }
}

export function readMobileRuntimeCapabilities(statusResult: unknown): string[] {
  if (!statusResult || typeof statusResult !== 'object') {
    return []
  }
  const capabilities = (statusResult as { capabilities?: unknown }).capabilities
  return Array.isArray(capabilities) && capabilities.every((value) => typeof value === 'string')
    ? capabilities
    : []
}
