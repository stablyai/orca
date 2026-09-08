import type { WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  WSL_RELAY_PROCESS_METHODS,
  type WslRelayIdentityResult
} from '../../shared/wsl-hook-relay-contract'
import type { WslShellProcessAnchor } from '../../shared/wsl-shell-process-anchor'

export let wslRelayIdentityRpcCount = 0

export function resetWslRelayIdentityRpcCount(): void {
  wslRelayIdentityRpcCount = 0
}

export async function readWslRelayProcessIdentity(options: {
  distro: string
  anchors: readonly WslShellProcessAnchor[]
  deps: WslHookRelayManagerDeps
  ensure: (distro: string) => Promise<void> | void
  getState: (distro: string) => { phase: string; mux?: SshChannelMultiplexer } | undefined
  disposed: boolean
  requestOptions?: { signal?: AbortSignal; timeoutMs?: number; stableUntilReset?: boolean }
}): Promise<WslRelayIdentityResult[]> {
  const unavailable = (reason: string): WslRelayIdentityResult[] =>
    options.anchors.map(() => ({ status: 'unverifiable' as const, reason, capturedAgeMs: 0 }))
  if (options.disposed || options.deps.platform() !== 'win32' || !options.distro.trim()) {
    return unavailable('wsl_unavailable')
  }
  // Identity reads must stay within their caller's deadline. Starting a relay
  // can boot WSL and install guest hooks, so trigger that work in the background
  // and report the current unavailable state until a later read observes it.
  try {
    void Promise.resolve(options.ensure(options.distro)).catch(() => undefined)
  } catch {
    // A disposed/tearing-down manager may reject synchronously; the read remains
    // an honest unavailable result.
  }
  const state = options.getState(options.distro)
  const mux = state?.mux
  if (!mux || mux.isDisposed() || state.phase !== 'running') {
    return unavailable('relay_unavailable')
  }
  wslRelayIdentityRpcCount++
  try {
    const response = (await mux.request(
      WSL_RELAY_PROCESS_METHODS.identityRead,
      { distro: options.distro, anchors: options.anchors },
      {
        signal: options.requestOptions?.signal,
        timeoutMs: options.requestOptions?.timeoutMs ?? 5_000
      }
    )) as { results?: unknown }
    if (!Array.isArray(response?.results) || response.results.length !== options.anchors.length) {
      return unavailable('capture_malformed')
    }
    return response.results as WslRelayIdentityResult[]
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    return unavailable(code === -32601 ? 'unsupported_capability' : 'capture_failed')
  }
}
