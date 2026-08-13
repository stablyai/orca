import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { resolveCodexAccount } from '../orchestration-interaction-loop'
import { RuntimeClientError } from '../runtime-client'
import type { ClaudeRateLimitAccountsState, CodexRateLimitAccountsState } from '../../shared/types'

type AccountsListSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
}

export const selectManagedAccount: CommandHandler = async (ctx) => {
  const agent = getRequiredStringFlag(ctx.flags, 'agent')
  if (agent !== 'claude' && agent !== 'codex') {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --agent "${agent}". Use "claude" or "codex".`
    )
  }
  const selector = getRequiredStringFlag(ctx.flags, 'account')
  const snapshot = await ctx.client.call<AccountsListSnapshot>('accounts.list', {
    refreshUsage: false
  })
  let accountId: string
  if (agent === 'codex') {
    try {
      accountId = resolveCodexAccount(snapshot.result.codex.accounts, selector).id
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        error instanceof Error ? error.message : String(error)
      )
    }
  } else {
    const matches = snapshot.result.claude.accounts.filter(
      (account) => account.id === selector || account.email === selector
    )
    if (matches.length !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        matches.length > 1
          ? `Claude account selector "${selector}" is ambiguous; use the exact account ID.`
          : `Claude account selector "${selector}" did not match a managed account.`
      )
    }
    accountId = matches[0]!.id
  }
  const selected = await ctx.client.call<
    ClaudeRateLimitAccountsState | CodexRateLimitAccountsState
  >(agent === 'codex' ? 'accounts.selectCodex' : 'accounts.selectClaude', { accountId })
  const activeAccountId =
    selected.result.activeAccountIdsByRuntime?.host ?? selected.result.activeAccountId
  if (activeAccountId !== accountId) {
    throw new RuntimeClientError(
      'operation_unknown',
      `Orca did not confirm ${agent} account ${accountId} as active.`
    )
  }
  printResult(selected, ctx.json, (state) => {
    const account = state.accounts.find((candidate) => candidate.id === accountId)
    const label = account && 'workspaceLabel' in account ? account.workspaceLabel : undefined
    return `Selected ${agent} account ${label ? `${label} — ` : ''}${account?.email ?? accountId} (${accountId})`
  })
}
