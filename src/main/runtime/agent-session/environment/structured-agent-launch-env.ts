import { buildConfiguredProxyEnv } from '../../../../shared/network/network-proxy'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveTuiAgentLaunchEnv } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { overlayEnvironmentVariables } from '../../../../shared/shell/launch/environment-overlay'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

export type StructuredAgentLaunchEnvSettings = Pick<
  GlobalSettings,
  'agentDefaultEnv' | 'httpProxyUrl' | 'httpProxyBypassRules'
>

/** The settings overlay every chat agent child launches with: the configured proxy, as terminals get it, under the agent's own env. */
export function structuredAgentSettingsEnv(
  agent: string,
  settings: Partial<StructuredAgentLaunchEnvSettings>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  return overlayEnvironmentVariables(
    buildConfiguredProxyEnv(settings),
    isTuiAgent(agent) ? resolveTuiAgentLaunchEnv(agent, settings) : undefined,
    platform
  )
}

/** The settings overlay with the host's account overlay for `agent` on top. */
export function structuredAgentLaunchEnv(
  agent: string,
  settings: Partial<StructuredAgentLaunchEnvSettings>,
  accountEnv: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  return overlayEnvironmentVariables(
    structuredAgentSettingsEnv(agent, settings, platform),
    accountEnv,
    platform
  )
}
