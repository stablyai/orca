import { CapabilityProbeCache } from '../../../shared/capability-probe-cache'

// Retry missing RPCs periodically so in-place Codex upgrades recover without restarting Orca.
export const CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000
export const CODEX_APP_SERVER_CAPABILITY_MAX_ENTRIES = 256

/** The WSL distro that runs the codex binary; each can carry a different codex. */
export type CodexAppServerHostKey = `wsl:${string}`

export function getCodexAppServerHostKey(host: { distro: string }): CodexAppServerHostKey {
  return `wsl:${host.distro}`
}

// Concurrent pane launches share one probe per host instead of spawning duplicate app-servers.
export class CodexAppServerCapabilityCache extends CapabilityProbeCache<CodexAppServerHostKey> {
  constructor() {
    super(CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS, CODEX_APP_SERVER_CAPABILITY_MAX_ENTRIES)
  }
}

export const codexAppServerCapabilityCache = new CodexAppServerCapabilityCache()
