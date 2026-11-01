import type { ManagedDataAccountsState } from '../../shared/managed-account-types'

type AccountsBlock = {
  accounts: readonly { id: string; email: string; needsSignIn?: true }[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: {
    host: string | null
    wsl: Record<string, string | null>
  }
  /** Claude: the login System default holds, when the host could read it. */
  systemDefaultEmail?: string
  /** Codex: the resolved identity of the host's real ~/.codex. */
  systemDefault?: { email: string | null }
}

function formatSystemDefaultRow(block: AccountsBlock): string {
  const email = block.systemDefaultEmail ?? block.systemDefault?.email ?? null
  const hostActiveId = block.activeAccountIdsByRuntime
    ? block.activeAccountIdsByRuntime.host
    : block.activeAccountId
  return `  system  System default${email ? `: ${email}` : ''}${hostActiveId === null ? ' (active)' : ''}`
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
  const system = formatSystemDefaultRow(block)
  if (block.accounts.length === 0) {
    return `No managed ${label} accounts.\n${system}`
  }
  const activeAccountIds = new Set([
    block.activeAccountId,
    block.activeAccountIdsByRuntime?.host,
    ...Object.values(block.activeAccountIdsByRuntime?.wsl ?? {})
  ])
  const lines = block.accounts.map(
    (account) =>
      `  ${account.email}${activeAccountIds.has(account.id) ? ' (active)' : ''}${
        account.needsSignIn ? ' (sign in again in Orca Settings > AI Provider Accounts)' : ''
      }`
  )
  return `Managed ${label} accounts (${block.accounts.length}):\n${system}\n${lines.join('\n')}`
}
