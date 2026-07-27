import type { ClaudeRateLimitAccountsState } from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import { formatClaudeAccountList, printResult } from '../format'
import { getRequiredStringFlag } from '../flags'
import { resolveClaudeAccountId } from '../account-selector'

type AccountsSnapshot = { claude: ClaudeRateLimitAccountsState }

function accountSelector(flags: Map<string, string | boolean>): string | null {
  const selector = getRequiredStringFlag(flags, 'account')
  return selector === 'null' ? null : selector
}

export const ACCOUNT_HANDLERS: Record<string, CommandHandler> = {
  'account list': async ({ client, json }) => {
    const result = await client.call<AccountsSnapshot>('accounts.list')
    printResult({ ...result, result: result.result.claude }, json, formatClaudeAccountList)
  },
  'account use': async ({ flags, client, json }) => {
    const selector = accountSelector(flags)
    const snapshot = await client.call<AccountsSnapshot>('accounts.list')
    const accountId = resolveClaudeAccountId(snapshot.result.claude, selector)
    const result = await client.call<ClaudeRateLimitAccountsState>('accounts.selectClaude', {
      accountId
    })
    printResult(result, json, formatClaudeAccountList)
  }
}
