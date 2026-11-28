import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { ProviderRelaySpawnSpec } from '../daemon/protocol/daemon-provider-relay-protocol'
import {
  resolveProviderChildEnv,
  type ProviderProcessLaunch
} from '../provider-process/provider-process-launch'
import { processEnvWithoutAgentSession } from '../../shared/agent-launch/startup/parent-agent-session-env'
import { resolveProviderExecPath } from '../provider-process/provider-exec-path'
import {
  missingProviderRelayCapability,
  traceProviderRelayCapabilityFallback
} from './provider-relay-capability-fallback'

/** What the daemon is asked to spawn for a chat's agent; null where it can't relay. */
export function providerRelaySpawnSpec(
  launch: ProviderProcessLaunch,
  client: DaemonClient,
  appVersion: ProviderRelaySpawnSpec['appVersion'],
  { inheritedEnv, keep }: { inheritedEnv?: Record<string, string>; keep?: unknown } = {}
): ProviderRelaySpawnSpec | null {
  const identity = client.getDaemonIdentity()
  // A daemon kept from another bundle relays too, when it speaks the relay protocol. Without kept
  // state a reattach would have nothing to restore, so such a launch goes as today.
  const missing = missingProviderRelayCapability(identity, keep !== undefined)
  if (!identity || missing) {
    traceProviderRelayCapabilityFallback(identity, missing ?? 'providerRelay')
    return null
  }
  if (!launch.cwd) {
    return null
  }
  const env: Record<string, string> = {}
  const resolved = resolveProviderChildEnv(
    launch,
    inheritedEnv ?? processEnvWithoutAgentSession(process.platform)
  )
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
