import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
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
  agent: 'claude' | 'codex'
  location: AgentSessionExecutionLocation
  adapterSupportsCreate: boolean
  getSettings: () => ClaudeManagedAccountGateSettings
  /** True when a project-group binding owns this workspace's Claude home. */
  boundClaudeHome?: boolean
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
  // A bound home is not the ambient config this gate describes, so it has nothing to say about it —
  // the same reason the acquisition gate skips it. Disagreeing here would make a bound group
  // unusable for exactly the users the binding exists for.
  if (
    input.agent === 'claude' &&
    !input.boundClaudeHome &&
    !structuredClaudeMatchesActiveManagedAccount(
      readClaudeManagedAccountGateSettings(input.getSettings)
    )
  ) {
    return { supported: false, reason: 'wsl' }
  }
  return { supported: true }
}
