import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { InitializeResponse } from '../generated/acp-protocol.generated'

type ForkSupport = NonNullable<AgentSessionOptionsResult['forkSupport']>
const versions = new Map<string, string | null>()
const observations = new Map<string, { version: string; support: ForkSupport }>()

/** Discovery belongs to the checked release; an upgrade cannot inherit its negative verdict. */
export function noteAcpForkVersion(agent: string, version: string | null): void {
  if (versions.get(agent) !== version) {
    observations.delete(agent)
  }
  versions.set(agent, version)
}

export function acpInitializeForkSupport(initialized: InitializeResponse): ForkSupport {
  return initialized.agentCapabilities?.sessionCapabilities?.fork != null
    ? 'supported'
    : 'unsupported'
}

export function observeAcpForkSupport(agent: string, initialized: InitializeResponse): void {
  const version = versions.get(agent) ?? initialized.agentInfo?.version
  if (version) {
    versions.set(agent, version)
    observations.set(agent, { version, support: acpInitializeForkSupport(initialized) })
  }
}

export function readAcpForkSupport(agent: string): ForkSupport {
  const observed = observations.get(agent)
  const version = versions.get(agent)
  return observed && (version === undefined || version === observed.version)
    ? observed.support
    : 'unknown'
}
