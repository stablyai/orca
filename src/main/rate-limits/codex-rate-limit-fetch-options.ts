import type { NetworkProxySettings } from '../../shared/network-proxy'

export type CodexRateLimitFetchOptions = {
  codexHomePath?: string | null
  signal?: AbortSignal
  networkProxySettings?: NetworkProxySettings
}
