import type { NetworkProxySettings } from '../../../../shared/network/network-proxy'
import type { UsageReadingAccount } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

export type CodexRateLimitFetchOptions = {
  codexHomePath?: string | null
  /** The saved account that owns `codexHomePath`; named on a successful reading. */
  readingAccount?: UsageReadingAccount
  /** Read HTTP usage only: app-server may refresh tokens of a login Orca has not selected. */
  backendUsageOnly?: boolean
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}
