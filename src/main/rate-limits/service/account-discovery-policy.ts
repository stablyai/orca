import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { ClaudeAccountSelectionTarget } from '../../claude-accounts/runtime-selection'
import { getSelectedClaudeAccountIdForTarget } from '../../claude-accounts/runtime-selection'
import { getSelectedCodexAccountIdForTarget } from '../../codex-accounts/runtime-selection'

export type AccountDiscoveryPolicy = {
  automaticallyDetect: boolean
  isConnected: (
    provider: ProviderRateLimits['provider'],
    target?: ClaudeAccountSelectionTarget
  ) => boolean
}
export type AccountDiscoveryPolicyResolver = () => AccountDiscoveryPolicy

export function createAccountDiscoveryPolicy(
  settings: GlobalSettings,
  saved: {
    opencodeGo: () => boolean
    minimax: () => boolean
    zcode: () => boolean
    antigravity: () => boolean
  }
): AccountDiscoveryPolicy {
  return {
    automaticallyDetect: settings.automaticallyDetectAiAccounts !== false,
    isConnected(provider, target) {
      switch (provider) {
        case 'claude': {
          const id = getSelectedClaudeAccountIdForTarget(settings, target)
          return settings.claudeManagedAccounts.some((account) => account.id === id)
        }
        case 'codex': {
          const id = getSelectedCodexAccountIdForTarget(settings, target)
          return settings.codexManagedAccounts.some((account) => account.id === id)
        }
        case 'gemini':
          return settings.geminiCliOAuthEnabled === true
        case 'opencode-go':
          return Boolean(settings.opencodeSessionCookie?.trim()) || saved.opencodeGo()
        case 'minimax':
          return saved.minimax()
        case 'zcode':
          return saved.zcode()
        case 'antigravity':
          return saved.antigravity()
        // Grok currently has only a CLI-owned auth.json, not an Orca credential store.
        case 'grok':
        case 'cursor':
        case 'kimi':
          return false
      }
    }
  }
}

export function discoveryDisabledSnapshot(
  provider: ProviderRateLimits['provider']
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'unavailable'
  }
}
