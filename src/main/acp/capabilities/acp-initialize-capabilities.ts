// What an agent's `initialize` advertised, kept per release so a launch can plan before it asks again.
import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { InitializeResponse } from '../generated/acp-protocol.generated'

type ForkSupport = NonNullable<AgentSessionOptionsResult['forkSupport']>
const versions = new Map<string, string | null>()
const observations = new Map<
  string,
  { version: string; support: ForkSupport; takesHttpTools: boolean }
>()

/** Discovery belongs to the checked release; an upgrade cannot inherit its negative verdict. */
export function noteAcpLaunchVersion(agent: string, version: string | null): void {
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

/** Whether the agent may take MCP servers at a URL; only an explicit `http: false` says no, since
 *  Antigravity 1.5.13 advertises no MCP capabilities yet uses the URL servers it is given. */
export function acpTakesHttpTools(initialized: InitializeResponse): boolean {
  return initialized.agentCapabilities?.mcpCapabilities?.http !== false
}

export function observeAcpInitialize(agent: string, initialized: InitializeResponse): void {
  const version = versions.get(agent) ?? initialized.agentInfo?.version
  if (version) {
    versions.set(agent, version)
    observations.set(agent, {
      version,
      support: acpInitializeForkSupport(initialized),
      takesHttpTools: acpTakesHttpTools(initialized)
    })
  }
}

function observed(agent: string) {
  const entry = observations.get(agent)
  const version = versions.get(agent)
  return entry && (version === undefined || version === entry.version) ? entry : null
}

export function readAcpForkSupport(agent: string): ForkSupport {
  return observed(agent)?.support ?? 'unknown'
}

/** Null until this release of the agent has answered an `initialize`. */
export function readAcpTakesHttpTools(agent: string): boolean | null {
  return observed(agent)?.takesHttpTools ?? null
}
