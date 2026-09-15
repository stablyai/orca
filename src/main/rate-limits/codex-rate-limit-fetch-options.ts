import type { NetworkProxySettings } from '../../shared/network-proxy'

export type CodexRateLimitFetchOptions = {
  codexHomePath?: string | null
  allowPtyFallback?: boolean
  signal?: AbortSignal
  networkProxySettings?: NetworkProxySettings
}
