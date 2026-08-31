import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

export type ClaudeRateLimitFetchOptions = {
  authPreparation?: ClaudeRuntimeAuthPreparation
  allowPtyFallback?: boolean
  allowUsagePanelSupplement?: boolean
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}

export type ClaudeManagedAccountUsageOptions = {
  allowUsagePanelSupplement?: boolean
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}
