import type { ClaudeRateLimitAccountsState } from '../shared/types'

export function formatClaudeAccountList(state: ClaudeRateLimitAccountsState): string {
  if (state.accounts.length === 0) {
    return 'No Claude accounts found.'
  }
  return state.accounts
    .map((account) => {
      const runtime = account.managedAuthRuntime ?? 'host'
      const activeId =
        runtime === 'wsl'
          ? state.activeAccountIdsByRuntime?.wsl?.[account.wslDistro?.trim() || '__default__']
          : (state.activeAccountIdsByRuntime?.host ?? state.activeAccountId)
      const active = account.id === activeId ? '* ' : '  '
      return `${active}${account.id} ${account.email} ${account.authMethod} ${runtime}`
    })
    .join('\n')
}
