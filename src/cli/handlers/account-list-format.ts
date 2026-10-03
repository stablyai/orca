import { isUnfinishedClaudeSignIn } from '../../shared/claude-unfinished-sign-in'

// Why: Claude and Codex managed-account summaries both carry id+email+active id,
// so one formatter renders either provider's block.
type AccountsBlock = {
  accounts: readonly {
    id: string
    email: string
    /** Claude only, from hosts that route through profiles. */
    profileReadiness?: string
    profileIdentityIssue?: string
  }[]
  /** Claude sign-ins with no login yet; a host keeps them out of `accounts`. */
  unfinishedAccounts?: readonly { id: string }[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: {
    host: string | null
    wsl: Record<string, string | null>
  }
}

/** Renders a provider's managed-account list as a human-readable block, marking the active account. */
export function formatAccountsBlock(label: string, block: AccountsBlock): string {
  const unfinished = block.unfinishedAccounts ?? []
  if (block.accounts.length + unfinished.length === 0) {
    return `No managed ${label} accounts.`
  }
  const activeAccountIds = new Set([
    block.activeAccountId,
    block.activeAccountIdsByRuntime?.host,
    ...Object.values(block.activeAccountIdsByRuntime?.wsl ?? {})
  ])
  const lines = [
    ...block.accounts.map(
      (account) =>
        `  ${isUnfinishedClaudeSignIn(account) ? 'Unfinished sign-in' : account.email}${activeAccountIds.has(account.id) ? ' (active)' : ''}${accountAttentionHint(account)}`
    ),
    ...unfinished.map(
      () => '  Unfinished sign-in (finish or remove it in Orca Settings > Accounts)'
    )
  ]
  return `Managed ${label} accounts (${lines.length}):\n${lines.join('\n')}`
}

function accountAttentionHint(account: AccountsBlock['accounts'][number]): string {
  if (account.profileReadiness === 'sign-in-required') {
    return ' (sign in again in Orca Settings > Accounts)'
  }
  const notReady =
    account.profileReadiness !== undefined &&
    account.profileReadiness !== 'ready' &&
    account.profileReadiness !== 'unsupported'
  return notReady || account.profileIdentityIssue
    ? ' (needs attention in Orca Settings > Accounts)'
    : ''
}
