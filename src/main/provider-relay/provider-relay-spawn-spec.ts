import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { ProviderRelaySpawnSpec } from '../daemon/protocol/daemon-provider-relay-protocol'
import {
  resolveProviderChildEnv,
  type ProviderProcessLaunch
} from '../provider-process/provider-process-launch'
import { processEnvWithoutAgentSession } from '../../shared/agent-launch/startup/parent-agent-session-env'
import { resolveProviderExecPath } from '../provider-process/provider-exec-path'

/** The daemon's spawn spec for a launch; null when this daemon can't relay for this app build. */
export function relaySpawnSpec(
  launch: ProviderProcessLaunch,
  client: DaemonClient,
  appVersion: string,
  inheritedEnv?: Record<string, string>
): ProviderRelaySpawnSpec | null {
  const identity = client.getDaemonIdentity()
  // A daemon kept from another bundle relays too, when it speaks the relay protocol.
  if (!identity?.providerRelay) {
    return null
  }
  if (!launch.cwd) {
    return null
  }
  const env: Record<string, string> = {}
  const base = inheritedEnv ?? processEnvWithoutAgentSession(process.platform)
  const resolved = resolveProviderChildEnv(launch, base)
  for (const [key, value] of Object.entries(resolved)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return {
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env,
    ownerExecutable: resolveProviderExecPath(),
    appVersion,
    ...(identity.entryPath ? { entryPath: identity.entryPath } : {})
  }
}

/** On macOS the daemon may lack permission for the chat's folder; only a readable one relays. */
export async function daemonReadsFolder(client: DaemonClient, cwd: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true
  }
  try {
    const reply = await client.request<{ outcome?: unknown } | null>(
      'probeProviderCwd',
      { cwd },
      1_500
    )
    return reply?.outcome === 'ok'
  } catch {
    return false
  }
}
