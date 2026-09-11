import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import {
  PROVIDER_LOGIN_REQUIRED_SUPPORT_REASON,
  type StructuredAgentSessionCreateSupportReason
} from '../../shared/structured-agent-session-create-support-reason'
import type { StructuredProviderLoginVerdict } from './structured-agent-session-provider-login-preflight'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  readClaudeManagedAccountGateSettings,
  structuredClaudeMatchesActiveManagedAccount,
  type ClaudeManagedAccountGateSettings
} from './claude-structured-managed-account-support'

export type StructuredAgentSessionCreateSupport = {
  supported: boolean
  reason?: StructuredAgentSessionCreateSupportReason
}

/**
 * The create-support verdict, kept out of the runtime class file because that file is `@ts-nocheck`
 * — a call site there is not typechecked, so an auth-identity decision written inline would compile
 * however wrong it was. The runtime hands over the facts it owns and this decides.
 */
export function resolveStructuredAgentSessionCreateSupport(input: {
  agent: 'claude' | 'codex'
  location: AgentSessionExecutionLocation
  adapterSupportsCreate: boolean
  providerLogin: StructuredProviderLoginVerdict
  getSettings: () => ClaudeManagedAccountGateSettings
}): StructuredAgentSessionCreateSupport {
  if (!input.adapterSupportsCreate) {
    return {
      supported: false,
      reason:
        input.location.executionHostId !== LOCAL_EXECUTION_HOST_ID
          ? 'remote'
          : input.location.wslDistro
            ? 'wsl'
            : 'agent'
    }
  }
  // Claude only: Codex resolves its account on a different path, so its answer is untouched here.
  // `wsl` is the closest existing reason — the cause is a WSL-bound account rather than a WSL
  // workspace — and no client reads the field, so it stays as-is.
  if (
    input.agent === 'claude' &&
    !structuredClaudeMatchesActiveManagedAccount(
      readClaudeManagedAccountGateSettings(input.getSettings)
    )
  ) {
    return { supported: false, reason: 'wsl' }
  }
  // Only a positively observed missing credential refuses. `unverifiable` is loss of evidence and
  // must answer exactly as `present` does, or an unreadable probe becomes a denial of service.
  if (input.providerLogin === 'missing') {
    return { supported: false, reason: PROVIDER_LOGIN_REQUIRED_SUPPORT_REASON }
  }
  return { supported: true }
}
