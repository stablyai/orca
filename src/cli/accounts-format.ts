import type {
  RuntimeAccountPollAddResult,
  RuntimeAccountProvider,
  RuntimeAccountsSnapshot
} from '../shared/runtime-types'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState,
  CodexManagedAccountSummary,
  CodexRateLimitAccountsState
} from '../shared/managed-account-types'
import type { ProviderRateLimits } from '../shared/rate-limit-types'

type AccountRow = {
  provider: RuntimeAccountProvider
  email: string
  id: string
  active: boolean
  usage: string
}

/** Usage-rich table for `account list`; `agent` narrows it to one provider. */
export function formatAccountsList(
  snapshot: RuntimeAccountsSnapshot,
  agent?: RuntimeAccountProvider
): string {
  const providers: readonly RuntimeAccountProvider[] = agent ? [agent] : ['codex', 'claude']
  const rows = providers.flatMap((provider) => accountRows(provider, snapshot[provider], snapshot))
  if (rows.length === 0) {
    return agent
      ? `No managed ${agent} accounts. Run \`orca account add --agent ${agent}\` to add one.`
      : 'No managed accounts. Run `orca account add --agent codex|claude` to add one.'
  }

  const widths = {
    provider: Math.max(8, ...rows.map((row) => row.provider.length)),
    email: Math.max(5, ...rows.map((row) => row.email.length)),
    id: Math.max(2, ...rows.map((row) => row.id.length)),
    active: 6
  }
  const header = [
    'PROVIDER'.padEnd(widths.provider),
    'EMAIL'.padEnd(widths.email),
    'ID'.padEnd(widths.id),
    'ACTIVE'.padEnd(widths.active),
    'USAGE'
  ].join('  ')
  const body = rows.map((row) =>
    [
      row.provider.padEnd(widths.provider),
      row.email.padEnd(widths.email),
      row.id.padEnd(widths.id),
      (row.active ? 'yes' : 'no').padEnd(widths.active),
      row.usage
    ].join('  ')
  )
  return [header, ...body].join('\n')
}

function accountRows(
  provider: RuntimeAccountProvider,
  state: CodexRateLimitAccountsState | ClaudeRateLimitAccountsState,
  snapshot: RuntimeAccountsSnapshot
): AccountRow[] {
  const inactiveUsageByAccountId = new Map(
    (provider === 'codex'
      ? snapshot.rateLimits.inactiveCodexAccounts
      : snapshot.rateLimits.inactiveClaudeAccounts
    ).map((entry) => [entry.accountId, entry.rateLimits])
  )
  // Why: an account can be active only on a WSL slot, so the ACTIVE column reads
  // every runtime slot — but the live snapshot only tracks the fetch target's
  // usage, so usage still keys off activeAccountId alone.
  const activeAccountIds = new Set([
    state.activeAccountId,
    state.activeAccountIdsByRuntime?.host,
    ...Object.values(state.activeAccountIdsByRuntime?.wsl ?? {})
  ])
  return state.accounts.map((account) => {
    const active = activeAccountIds.has(account.id)
    const rateLimits =
      account.id === state.activeAccountId
        ? (snapshot.rateLimits[provider] ?? null)
        : (inactiveUsageByAccountId.get(account.id) ?? null)
    return {
      provider,
      email: account.email,
      id: account.id,
      active,
      usage: formatUsage(rateLimits)
    }
  })
}

function formatUsage(rateLimits: ProviderRateLimits | null): string {
  if (!rateLimits) {
    return 'n/a'
  }
  const parts: string[] = []
  if (rateLimits.session) {
    parts.push(`5h ${Math.round(rateLimits.session.usedPercent)}%`)
  }
  if (rateLimits.weekly) {
    parts.push(`7d ${Math.round(rateLimits.weekly.usedPercent)}%`)
  }
  return parts.length > 0 ? parts.join(', ') : 'n/a'
}

export function formatAccountAddStarted(provider: RuntimeAccountProvider, loginId: string): string {
  return `Starting ${provider} login (loginId ${loginId})...`
}

export function formatAccountAddResult(
  result: RuntimeAccountPollAddResult,
  options: { omitLoginUrl?: boolean } = {}
): string {
  if (result.status === 'in_progress') {
    return `${result.provider} login is still in progress (loginId ${result.loginId}).`
  }
  if (result.status === 'failed') {
    return `${result.provider} login failed: ${result.error ?? 'unknown error'}`
  }
  const account = findAddedAccount(result)
  const accountLine = account
    ? `Added ${result.provider} account: ${account.email} (${account.id})`
    : `${result.provider} login completed.`
  return result.loginUrl && !options.omitLoginUrl
    ? `${accountLine}\nLogin URL: ${result.loginUrl}`
    : accountLine
}

function findAddedAccount(
  result: RuntimeAccountPollAddResult
): CodexManagedAccountSummary | ClaudeManagedAccountSummary | undefined {
  const state = result.state
  if (!state || !state.activeAccountId) {
    return undefined
  }
  return state.accounts.find((account) => account.id === state.activeAccountId)
}

export function formatAccountSelectResult(
  provider: RuntimeAccountProvider,
  state: CodexRateLimitAccountsState | ClaudeRateLimitAccountsState
): string {
  if (!state.activeAccountId) {
    return `No active ${provider} account.`
  }
  const account = state.accounts.find((entry) => entry.id === state.activeAccountId)
  return account
    ? `Active ${provider} account: ${account.email} (${account.id})`
    : `Active ${provider} account: ${state.activeAccountId}`
}

export function formatAccountRemoveResult(
  provider: RuntimeAccountProvider,
  state: CodexRateLimitAccountsState | ClaudeRateLimitAccountsState
): string {
  return `Removed ${provider} account. ${state.accounts.length} account(s) remain.`
}

// Why: Claude and Codex managed-account summaries both carry id+email+active id,
// so one formatter renders either provider's block for the local `account add` flow.
type AccountsBlock = {
  accounts: readonly { id: string; email: string }[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: {
    host: string | null
    wsl: Record<string, string | null>
  }
}

/** Renders a provider's managed-account list as a human-readable block, marking the active account. */
export function formatAccountsBlock(label: string, block: AccountsBlock): string {
  if (block.accounts.length === 0) {
    return `No managed ${label} accounts.`
  }
  const activeAccountIds = new Set([
    block.activeAccountId,
    block.activeAccountIdsByRuntime?.host,
    ...Object.values(block.activeAccountIdsByRuntime?.wsl ?? {})
  ])
  const lines = block.accounts.map(
    (account) => `  ${account.email}${activeAccountIds.has(account.id) ? ' (active)' : ''}`
  )
  return `Managed ${label} accounts (${block.accounts.length}):\n${lines.join('\n')}`
}
