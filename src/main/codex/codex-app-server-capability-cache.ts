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
 * Capability cache for the codex app-server trust-grant RPC pair, modeled on
 * GitCapabilityCache but with a synchronous runner: the grant client blocks
 * the main thread by design (launch prep), so probes cannot overlap — the
 * unsupported mark alone is what keeps later installs off the dead probe.
 */
export class CodexAppServerCapabilityCache {
  private readonly retryAfterByHost = new Map<CodexAppServerHostKey, number>()
  private readonly supportedHosts = new Set<CodexAppServerHostKey>()

  shouldTry(hostKey: CodexAppServerHostKey, nowMs = Date.now()): boolean {
    const retryAfterMs = this.retryAfterByHost.get(hostKey)
    if (retryAfterMs === undefined) {
      return true
    }
    if (nowMs < retryAfterMs) {
      return false
    }
    this.retryAfterByHost.delete(hostKey)
    return true
  }

  isKnownSupported(hostKey: CodexAppServerHostKey): boolean {
    return this.supportedHosts.has(hostKey)
  }

  rememberUnsupported(hostKey: CodexAppServerHostKey, nowMs = Date.now()): void {
    this.supportedHosts.delete(hostKey)
    this.retryAfterByHost.set(hostKey, nowMs + CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS)
  }

  rememberSupported(hostKey: CodexAppServerHostKey): void {
    this.retryAfterByHost.delete(hostKey)
    this.supportedHosts.add(hostKey)
  }

  runWithFallbackSync<T>(
    hostKey: CodexAppServerHostKey,
    runPreferred: () => T,
    runFallback: () => T,
    isUnsupportedError: (error: unknown) => boolean,
    nowMs = Date.now()
  ): T {
    if (!this.supportedHosts.has(hostKey) && !this.shouldTry(hostKey, nowMs)) {
      return runFallback()
    }
    try {
      const result = runPreferred()
      this.rememberSupported(hostKey)
      return result
    } catch (error) {
      // Why: only a positive absence signal (unknown method / missing
      // subcommand) marks unsupported. Transient spawn failures, timeouts,
      // and RPC errors fall back once without poisoning the capability.
      if (!isUnsupportedError(error)) {
        throw error
      }
      this.rememberUnsupported(hostKey, nowMs)
      return runFallback()
    }
  }

  clear(): void {
    this.retryAfterByHost.clear()
    this.supportedHosts.clear()
  }
}

export const codexAppServerCapabilityCache = new CodexAppServerCapabilityCache()
