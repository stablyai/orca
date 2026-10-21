import type { NetworkProxySettings } from '../../shared/network-proxy'

export type CodexRateLimitFetchOptions = {
  codexHomePath?: string | null
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}
