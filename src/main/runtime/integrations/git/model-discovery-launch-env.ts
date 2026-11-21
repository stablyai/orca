import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  resolveTuiAgentLaunchEnv,
  type AgentLaunchProfileSettings
} from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { overlayEnvironmentVariables } from '../../../../shared/shell/launch/environment-overlay'

/** The env a terminal launch exports. The user's entries win over Orca's permission defaults. */
export function modelDiscoveryLaunchEnv(
  agentId: string,
  settings: AgentLaunchProfileSettings | null | undefined
): Record<string, string> {
  return isTuiAgent(agentId) ? resolveTuiAgentLaunchEnv(agentId, settings) : {}
}

function withoutPatchKeys(
  env: NodeJS.ProcessEnv,
  patch: Record<string, string>,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const blocked = new Set(
    Object.keys(patch).map((key) => (platform === 'win32' ? key.toUpperCase() : key))
  )
  const base: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const name = platform === 'win32' ? key.toUpperCase() : key
    if (!blocked.has(name)) {
      base[key] = value
    }
  }
  return base
}

/**
 * Precedence matches a terminal launch: login-shell base, then Orca defaults and the user's
 * `agentDefaultEnv`, then the account patch. `accountEnv` is the prepared environment, so the
 * patch is removed before the launch env is applied and put back on top.
 */
export function withModelDiscoveryLaunchEnv(
  launchEnv: Record<string, string>,
  accountEnv?: NodeJS.ProcessEnv,
  accountPatch?: Record<string, string>
): NodeJS.ProcessEnv | undefined {
  const patch = accountPatch ?? {}
  if (!accountEnv && Object.keys(launchEnv).length === 0 && Object.keys(patch).length === 0) {
    return undefined
  }
  if (!accountEnv) {
    return overlayEnvironmentVariables(launchEnv, patch, process.platform)
  }
  const launched = overlayEnvironmentVariables(
    withoutPatchKeys(accountEnv, patch, process.platform),
    launchEnv,
    process.platform
  )
  return overlayEnvironmentVariables(launched, patch, process.platform)
}
