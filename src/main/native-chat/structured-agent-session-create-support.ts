import { supportsAgentProfileHost } from '../../shared/agent-profile-capabilities'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  readClaudeManagedAccountGateSettings,
  structuredClaudeMatchesActiveManagedAccount,
  type ClaudeManagedAccountGateSettings
} from './claude-structured-managed-account-support'

export type StructuredAgentSessionCreateSupport = {
  supported: boolean
  reason?: 'agent' | 'remote' | 'wsl'
}

/**
 * The create-support verdict, kept out of the runtime class file because that file is `@ts-nocheck`
 * — a call site there is not typechecked, so an auth-identity decision written inline would compile
 * however wrong it was. The runtime hands over the two facts it owns and this decides.
 */
export function resolveStructuredAgentSessionCreateSupport(input: {
  agent: StructuredAgentId
  location: AgentSessionExecutionLocation
  adapterSupportsCreate: boolean
  profileBound?: boolean
  platform?: NodeJS.Platform
  getSettings: () => ClaudeManagedAccountGateSettings
}): StructuredAgentSessionCreateSupport {
  if (
    !input.adapterSupportsCreate ||
    (input.profileBound &&
      !supportsAgentProfileHost({
        platform: input.platform ?? process.platform,
        hostId: input.location.executionHostId,
        isWsl: Boolean(
          input.location.wslDistro || process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP
        )
      }))
  ) {
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
    !input.profileBound &&
    !structuredClaudeMatchesActiveManagedAccount(
      readClaudeManagedAccountGateSettings(input.getSettings)
    )
  ) {
    return { supported: false, reason: 'wsl' }
  }
  return { supported: true }
}
