import type { AntigravityAccountState } from '../../shared/antigravity-account-types'
import type { ManagedDataAccountsState } from '../../shared/managed-account-types'
import { getManagedAccountInlineLabel } from '../../shared/managed-account-display-names'

type AccountsBlock = {
  accounts: readonly { id: string; email: string; displayName?: string; needsSignIn?: true }[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: {
    host: string | null
    wsl: Record<string, string | null>
  }
}

export function formatDataAccounts(label: string, state: ManagedDataAccountsState): string {
  const system = `  system  System default${state.activeAccountId === null ? ' (active)' : ''}`
  if (state.accounts.length === 0) {
    return `No managed ${label} accounts.\n${system}`
  }
  return `Managed ${label} accounts (${state.accounts.length}):\n${system}\n${state.accounts
    .map(
      (account) =>
        `  ${account.id}  ${account.label}${account.id === state.activeAccountId ? ' (active)' : ''}`
    )
    .join('\n')}`
}

export function formatAccountsBlock(label: string, block: AccountsBlock): string {
  const hostAccountId = block.activeAccountIdsByRuntime?.host ?? block.activeAccountId
  const system = `  system  System default${hostAccountId === null ? ' (active)' : ''}`
  if (block.accounts.length === 0) {
    return `No managed ${label} accounts.\n${system}`
  }
  const activeAccountIds = new Set([
    block.activeAccountId,
    block.activeAccountIdsByRuntime?.host,
    ...Object.values(block.activeAccountIdsByRuntime?.wsl ?? {})
  ])
  // Why the id: `orca account select --account` needs it when one email signs into several orgs.
  const lines = block.accounts.map(
    (account) =>
      `  ${account.id}  ${getManagedAccountInlineLabel(account)}${activeAccountIds.has(account.id) ? ' (active)' : ''}${
        account.needsSignIn ? ' (sign in again in Orca Settings > AI Provider Accounts)' : ''
      }`
  )
  return `Managed ${label} accounts (${block.accounts.length}):\n${system}\n${lines.join('\n')}`
}

/** Antigravity has no system default: one saved account always owns the native login. */
export function formatAntigravityAccounts(state: AntigravityAccountState): string {
  if (state.accounts.length === 0) {
    return 'No managed Antigravity accounts.'
  }
  return `Managed Antigravity accounts (${state.accounts.length}):\n${state.accounts
    .map(
      (account) =>
        `  ${account.id}  ${account.email ?? account.subject ?? account.id}${
          account.id === state.activeAccountId ? ' (active)' : ''
        }`
    )
    .join('\n')}`
}
