import { CapabilityProbeCache } from '../../shared/capability-probe-cache'

// Why: suppress a known-missing RPC surface without pinning it forever — an
// in-place codex upgrade during a long Orca session self-heals after the
// interval, mirroring GitCapabilityCache's rationale.
export const CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000

/** Execution host that runs the codex binary. WSL distros are isolated from
 *  the native host and from each other — each can carry a different codex. */
export type CodexAppServerHostKey = 'native' | `wsl:${string}`

export function getCodexAppServerHostKey(
  host: { kind: 'native' } | { kind: 'wsl'; distro: string }
): CodexAppServerHostKey {
  return host.kind === 'wsl' ? `wsl:${host.distro}` : 'native'
}

/**
 * Capability cache for the codex app-server trust-grant RPC pair. The grant
 * client runs off the main thread's critical path, so two pane launches can
 * probe the same host at once; the shared probe dedupe is what keeps a cold
 * host to one app-server session instead of one per concurrent launch.
 */
export class CodexAppServerCapabilityCache extends CapabilityProbeCache<CodexAppServerHostKey> {
  constructor() {
    super(CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS)
  }
}

export const codexAppServerCapabilityCache = new CodexAppServerCapabilityCache()
