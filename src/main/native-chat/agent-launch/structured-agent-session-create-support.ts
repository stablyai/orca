import type { AgentCliInstallationProblem } from '../../../shared/agent-launch/catalog/agent-cli-installation-problem'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'

export type StructuredAgentSessionCreateSupport = {
  supported: boolean
  reason?: 'agent' | 'remote' | 'wsl' | 'windows' | 'workspace-access'
  /** The installed release is older than chats need; host-side only, never in the createSupport reply. */
  installation?: AgentCliInstallationProblem
}

export function resolveStructuredAgentSessionCreateSupport(input: {
  location: AgentSessionExecutionLocation
  adapterSupportsCreate: boolean
  /** The agent has no chat on this host's OS, so no install or update can help. */
  unavailableOnPlatform?: boolean
  /** The workspace directory itself is inaccessible (EACCES/EPERM), not the agent CLI. */
  workspaceAccessDenied?: boolean
}): StructuredAgentSessionCreateSupport {
  if (!input.adapterSupportsCreate) {
    return {
      supported: false,
      reason:
        input.location.executionHostId !== LOCAL_EXECUTION_HOST_ID
          ? 'remote'
          : input.location.wslDistro
            ? 'wsl'
            : input.unavailableOnPlatform
              ? 'windows'
              : input.workspaceAccessDenied
                ? 'workspace-access'
                : 'agent'
    }
  }
  return { supported: true }
}

export type StructuredAgentSessionCreateSupportCheck = 'location' | 'installed-agent'

/** Log the failing check once per terminal fallback; omit paths and environment values. */
export function warnStructuredAgentSessionCreateUnsupported(
  agent: StructuredAgentId,
  support: StructuredAgentSessionCreateSupport,
  check: StructuredAgentSessionCreateSupportCheck
): void {
  if (!support.supported) {
    console.warn(
      `[structured-create-support] ${agent} unsupported: ${check} check refused (reason ${support.reason ?? 'none'})`
    )
  }
}
