import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  ACCOUNT_USAGE_AGENTS,
  type AccountsUsageSnapshot,
  buildAccountUsageRows,
  formatAccountUsage
} from './account-usage-format'

/** Prints per-account rate-limit usage from the host's accounts snapshot. */
export async function showAccountUsage({ client, flags, json }: HandlerContext): Promise<void> {
  const agent = flags.get('agent')
  if (agent !== undefined && !ACCOUNT_USAGE_AGENTS.some((known) => known === agent)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --agent "${String(agent)}". Use one of: ${ACCOUNT_USAGE_AGENTS.join(', ')}.`
    )
  }
  const response = await client.call<Partial<AccountsUsageSnapshot>>(
    'accounts.list',
    { refreshUsage: flags.get('fresh') === true },
    { timeoutMs: 120_000 }
  )
  const { claude, codex, rateLimits } = response.result
  if (!claude || !codex || !rateLimits) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime does not report account usage. Update or restart Orca and try again.'
    )
  }
  const accounts = buildAccountUsageRows({ claude, codex, rateLimits }).filter(
    (row) => agent === undefined || row.agent === agent
  )
  printResult({ ...response, result: { accounts } }, json, (result) =>
    formatAccountUsage(result.accounts, Date.now())
  )
}
