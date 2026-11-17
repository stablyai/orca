import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export type StructuredAgentSessionCreateSupport = {
  supported: boolean
  reason?: 'agent' | 'remote' | 'wsl' | 'windows'
}

export function resolveStructuredAgentSessionCreateSupport(input: {
  location: AgentSessionExecutionLocation
  adapterSupportsCreate: boolean
  /** The agent has no chat on this host's OS, so no install or update can help. */
  unavailableOnPlatform?: boolean
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
