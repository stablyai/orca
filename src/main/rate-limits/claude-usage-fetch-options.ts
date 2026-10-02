import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

/** Lets the account's own Claude CLI refresh an expired login; absent means never start Claude. */
export type ClaudeCliLoginRefreshPermit = {
  /** The login now selected for this fetch's target, read without syncing. */
  readCurrentAuthProvenance: () => string
}

export type ClaudeRateLimitFetchOptions = {
  authPreparation?: ClaudeRuntimeAuthPreparation
  cliLoginRefresh?: ClaudeCliLoginRefreshPermit
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}

export type ClaudeManagedAccountUsageOptions = {
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}
