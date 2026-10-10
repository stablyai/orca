import type { NetworkProxySettings } from '../../shared/network-proxy'

export type CodexRateLimitFetchOptions = {
  codexHomePath?: string | null
  /** Orca's configured proxy; Node's fetch and a bare child env would skip it. */
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}
