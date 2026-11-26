import { buildConfiguredProxyEnv } from '../../../../shared/network/network-proxy'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveTuiAgentLaunchEnv } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { overlayEnvironmentVariables } from '../../../../shared/shell/launch/environment-overlay'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

export type StructuredAgentLaunchEnvSettings = Pick<
  GlobalSettings,
  'agentDefaultEnv' | 'httpProxyUrl' | 'httpProxyBypassRules'
>

/** The configured proxy minus every spelling of a variable an override sets; proxy readers prefer
 * the lowercase name, so a leftover alias would mask the user's own value on any platform. */
function configuredProxyEnvUnder(
  settings: Partial<StructuredAgentLaunchEnvSettings>,
  overrides: readonly Readonly<Record<string, string>>[]
): Record<string, string> {
  const overridden = new Set(
    overrides.flatMap((env) => Object.keys(env).map((key) => key.toUpperCase()))
  )
  return Object.fromEntries(
    Object.entries(buildConfiguredProxyEnv(settings)).filter(
      ([key]) => !overridden.has(key.toUpperCase())
    )
  )
}

/** The settings overlay with the host's account overlay for `agent` on top: the configured proxy, as
 * terminals get it, under the agent's own env and account. */
export function structuredAgentLaunchEnv(
  agent: string,
  settings: Partial<StructuredAgentLaunchEnvSettings>,
  accountEnv: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const agentEnv = isTuiAgent(agent) ? resolveTuiAgentLaunchEnv(agent, settings) : {}
  return overlayEnvironmentVariables(
    overlayEnvironmentVariables(
      configuredProxyEnvUnder(settings, [agentEnv, accountEnv]),
      agentEnv,
      platform
    ),
    accountEnv,
    platform
  )
}

/** The same overlay for a launch that has no account binding yet. */
export function structuredAgentSettingsEnv(
  agent: string,
  settings: Partial<StructuredAgentLaunchEnvSettings>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  return structuredAgentLaunchEnv(agent, settings, {}, platform)
}
