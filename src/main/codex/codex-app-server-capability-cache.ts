import { CapabilityProbeCache } from '../../shared/capability-probe-cache'

// Why: suppress a known-missing RPC surface without pinning it forever — an
// in-place codex upgrade during a long Orca session self-heals after the
// interval, mirroring GitCapabilityCache's rationale.
export const CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000
export const CODEX_APP_SERVER_CAPABILITY_MAX_ENTRIES = 256

/** The WSL distro that runs the codex binary; each can carry a different codex. */
export type CodexAppServerHostKey = `wsl:${string}`

export function getCodexAppServerHostKey(host: { distro: string }): CodexAppServerHostKey {
  return `wsl:${host.distro}`
}

/**
 * Capability cache for the codex app-server trust-grant RPC pair. The grant
 * client runs off the main thread's critical path, so two pane launches can
 * probe the same host at once; the shared probe dedupe is what keeps a cold
 * host to one app-server session instead of one per concurrent launch.
 */
export class CodexAppServerCapabilityCache extends CapabilityProbeCache<CodexAppServerHostKey> {
  constructor() {
    super(CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS, CODEX_APP_SERVER_CAPABILITY_MAX_ENTRIES)
  }
}

export const codexAppServerCapabilityCache = new CodexAppServerCapabilityCache()
