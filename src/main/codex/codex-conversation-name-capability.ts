// Whether a host's codex accepts `thread/name/set`, remembered per host.
//
// Naming pays for a model turn before it ever calls `thread/name/set`, so a
// host without that RPC bills a turn it can never use — on every acquisition,
// forever. Probing the capability first keeps a host that cannot be named from
// paying at all, and the bounded retry lets an in-place codex upgrade heal.

import { CapabilityProbeCache } from '../../shared/capability-probe-cache'
import type { CodexAppServerLaunch } from './codex-app-server-connection'
import { CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS } from './codex-app-server-capability-cache'

/** Keyed by the launch, not a native/WSL enum: the structured path carries no
 *  host discriminator, and the command plus CODEX_HOME already separates a
 *  native binary from a `wsl.exe` or `ssh` wrapper and from a second distro. */
export function codexConversationNameCapabilityKey(
  launch: Pick<CodexAppServerLaunch, 'command' | 'args' | 'env'>
): string {
  return JSON.stringify([launch.command, launch.args, launch.env?.CODEX_HOME ?? ''])
}

export const codexConversationNameCapabilityCache = new CapabilityProbeCache<string>(
  CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS
)
