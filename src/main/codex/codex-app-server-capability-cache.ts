import { createHash } from 'node:crypto'

// Why: suppress a known-missing RPC surface without pinning it forever — an
// in-place codex upgrade during a long Orca session self-heals after the
// interval, mirroring GitCapabilityCache's rationale.
export const CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000
export const MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS = 64
export const MAX_CODEX_APP_SERVER_HOST_KEY_CODE_UNITS = 4 * 1024

/** Execution host that runs the codex binary. WSL distros are isolated from
 *  the native host and from each other — each can carry a different codex. */
export type CodexAppServerHostKey = 'native' | `wsl:${string}`

function boundHostKey(hostKey: CodexAppServerHostKey): CodexAppServerHostKey {
  if (hostKey.length <= MAX_CODEX_APP_SERVER_HOST_KEY_CODE_UNITS) {
    return hostKey
  }
  return `wsl:sha256:${createHash('sha256').update(hostKey.slice('wsl:'.length)).digest('hex')}`
}

export function getCodexAppServerHostKey(
  host: { kind: 'native' } | { kind: 'wsl'; distro: string }
): CodexAppServerHostKey {
  if (host.kind === 'native') {
    return 'native'
  }
  return boundHostKey(`wsl:${host.distro}`)
}

type CodexAppServerCapabilityState =
  | { kind: 'supported' }
  | { kind: 'unsupported'; retryAfterMs: number }

/**
 * Capability cache for the codex app-server trust-grant RPC pair, modeled on
 * GitCapabilityCache but with a synchronous runner: the grant client blocks
 * the main thread by design (launch prep), so probes cannot overlap — the
 * unsupported mark alone is what keeps later installs off the dead probe.
 */
export class CodexAppServerCapabilityCache {
  private readonly stateByHost = new Map<CodexAppServerHostKey, CodexAppServerCapabilityState>()

  private getState(hostKey: CodexAppServerHostKey): CodexAppServerCapabilityState | undefined {
    const retainedHostKey = boundHostKey(hostKey)
    const state = this.stateByHost.get(retainedHostKey)
    if (state) {
      this.stateByHost.delete(retainedHostKey)
      this.stateByHost.set(retainedHostKey, state)
    }
    return state
  }

  private remember(hostKey: CodexAppServerHostKey, state: CodexAppServerCapabilityState): void {
    const retainedHostKey = boundHostKey(hostKey)
    this.stateByHost.delete(retainedHostKey)
    this.stateByHost.set(retainedHostKey, state)
    while (this.stateByHost.size > MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS) {
      const oldestHost = this.stateByHost.keys().next().value
      if (oldestHost === undefined) {
        return
      }
      this.stateByHost.delete(oldestHost)
    }
  }

  shouldTry(hostKey: CodexAppServerHostKey, nowMs = Date.now()): boolean {
    const state = this.getState(hostKey)
    if (!state || state.kind === 'supported') {
      return true
    }
    if (nowMs < state.retryAfterMs) {
      return false
    }
    this.stateByHost.delete(boundHostKey(hostKey))
    return true
  }

  isKnownSupported(hostKey: CodexAppServerHostKey): boolean {
    return this.getState(hostKey)?.kind === 'supported'
  }

  rememberUnsupported(hostKey: CodexAppServerHostKey, nowMs = Date.now()): void {
    this.remember(hostKey, {
      kind: 'unsupported',
      retryAfterMs: nowMs + CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS
    })
  }

  rememberSupported(hostKey: CodexAppServerHostKey): void {
    this.remember(hostKey, { kind: 'supported' })
  }

  runWithFallbackSync<T>(
    hostKey: CodexAppServerHostKey,
    runPreferred: () => T,
    runFallback: () => T,
    isUnsupportedError: (error: unknown) => boolean,
    nowMs = Date.now()
  ): T {
    if (!this.shouldTry(hostKey, nowMs)) {
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
    this.stateByHost.clear()
  }
}

export const codexAppServerCapabilityCache = new CodexAppServerCapabilityCache()
