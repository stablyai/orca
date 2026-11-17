import { buildConfiguredProxyEnv } from '../../../../shared/network/network-proxy'
import { resolveTuiAgentLaunchEnv } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { overlayEnvironmentVariables } from '../../../../shared/shell/launch/environment-overlay'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

export type StructuredAgentLaunchEnvSettings = Pick<
  GlobalSettings,
  'agentDefaultEnv' | 'httpProxyUrl' | 'httpProxyBypassRules'
>

/** The settings overlay a chat agent launches with: the configured proxy, as terminals get it, under the agent's own env and account. */
export function structuredAgentLaunchEnv(
  agent: string,
  settings: Partial<StructuredAgentLaunchEnvSettings>,
  accountEnv: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const proxyAndAgentEnv = overlayEnvironmentVariables(
    buildConfiguredProxyEnv(settings),
    resolveTuiAgentLaunchEnv(agent, settings),
    platform
  )
  return overlayEnvironmentVariables(proxyAndAgentEnv, accountEnv, platform)
}
