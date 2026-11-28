import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { ProviderRelaySpawnSpec } from '../daemon/protocol/daemon-provider-relay-protocol'
import {
  resolveProviderChildEnv,
  type ProviderProcessLaunch
} from '../provider-process/provider-process-launch'
import { processEnvWithoutAgentSession } from '../../shared/agent-launch/startup/parent-agent-session-env'
import { resolveProviderExecPath } from '../provider-process/provider-exec-path'
import { inspectMacProcessCodeIdentity } from '../daemon/executable-host/macos/daemon-mac-code-identity'

/** What the daemon is asked to spawn for a chat's agent; null where it can't relay. */
export function providerRelaySpawnSpec(
  launch: ProviderProcessLaunch,
  client: DaemonClient,
  appVersion: ProviderRelaySpawnSpec['appVersion'],
  { inheritedEnv }: { inheritedEnv?: Record<string, string> } = {}
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

/**
 * On macOS the daemon may lack permission for the chat's folder; only a readable one relays. An
 * agent serving several chats' folders (`anyFolder`) can't be probed for each, so its daemon must
 * also run a bundle that still resolves: an updated app's older daemon may read home but not a
 * protected worktree its chats use.
 */
export async function daemonReadsFolder(
  client: DaemonClient,
  cwd: string,
  anyFolder = false
): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true
  }
  if (anyFolder) {
    const image = await inspectMacProcessCodeIdentity(client.getDaemonIdentity()?.pid)
    if (image.identity !== 'resolved' && image.identity !== 'parked') {
      return false
    }
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
