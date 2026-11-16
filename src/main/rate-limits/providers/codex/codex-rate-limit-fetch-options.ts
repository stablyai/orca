import type { NetworkProxySettings } from '../../../../shared/network-proxy'
import type { UsageReadingAccount } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

export type CodexRateLimitFetchOptions = {
  codexHomePath?: string | null
  /** The saved account that owns `codexHomePath`; named on a successful reading. */
  readingAccount?: UsageReadingAccount
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}
