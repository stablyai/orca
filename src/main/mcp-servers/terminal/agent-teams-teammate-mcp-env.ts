// Claude replays an Agent Teams lead's --mcp-config on each teammate's command line, but a teammate
// starts in a pane of its own with the team's env, so the relay env its config names comes from here.
import { MCP_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { isMcpServersFeatureEnabled } from '../mcp-servers-feature'

/** The relay env the lead's terminal got from the host list (none with the switch off). */
export function teammateMcpRelayEnv(
  leadEnv: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  if (!isMcpServersFeatureEnabled() || !leadEnv[MCP_TOKEN_ENV]) {
    return {}
  }
  const env: Record<string, string> = {}
  for (const key of [MCP_TOKEN_ENV, 'NO_PROXY', 'no_proxy']) {
    const value = leadEnv[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}
