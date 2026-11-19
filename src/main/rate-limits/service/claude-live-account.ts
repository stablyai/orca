import type { InactiveClaudeAccount } from '../providers/claude/claude-managed-account-usage'
import { getClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { normalizeClaudeConfigDir } from './service-types'
import { toWindowsWslPath } from '../../../shared/file-access/wsl-paths'

export function resolveClaudeLiveAccount(
  configDir: string | null,
  accounts: InactiveClaudeAccount[],
  accountId?: string | null
) {
  const normalized = normalizeClaudeConfigDir(configDir)
  if (!normalized) {
    return null
  }
  for (const account of accounts) {
    if (accountId ? account.id !== accountId : account.id.startsWith('system-default:host:')) {
      continue
    }
    const wsl = account.managedAuthRuntime === 'wsl'
    const home = wsl
      ? account.wslLinuxAuthPath
      : account.id.startsWith('system-default:host:')
        ? getClaudeProfileRouter()?.systemDefaultHome()
        : getClaudeProfileRouter()?.accountHome(account.id)
    const paths = home
      ? [home, ...(wsl && account.wslDistro ? [toWindowsWslPath(home, account.wslDistro)] : [])]
      : []
    if (paths.some((path) => normalizeClaudeConfigDir(path) === normalized)) {
      return {
        accountId: account.id,
        runtime: wsl ? ('wsl' as const) : ('host' as const),
        wslDistro: wsl ? (account.wslDistro ?? null) : null
      }
    }
  }
  return null
}
