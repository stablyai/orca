import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import { claudeAccountTokenRefreshEnabled } from '../../shared/claude-account-switch-settings'
import {
  claudeOAuthRefreshRows,
  setClaudeOAuthRefreshEnabled
} from '../rate-limits/claude-oauth-refresh-state'

export function installClaudeTokenRefresh(store: {
  getSettings: () => { claudeAccountTokenRefresh?: boolean }
}): void {
  setClaudeOAuthRefreshEnabled(() => claudeAccountTokenRefreshEnabled(store.getSettings()))
}

export function claudeTokenRefreshFields(
  settings: { claudeAccountTokenRefresh?: boolean },
  accounts: readonly { id: string; lastAuthenticatedAt?: number | null }[]
): Required<Pick<ClaudeRateLimitAccountsState, 'tokenRefresh' | 'tokenRefreshAccounts'>> {
  return {
    tokenRefresh: claudeAccountTokenRefreshEnabled(settings) ? 'on' : 'off',
    tokenRefreshAccounts: claudeOAuthRefreshRows(accounts)
  }
}
