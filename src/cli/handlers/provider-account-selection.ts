import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import { getWslAccountTarget } from './account-wsl-location'
import { formatAccountsBlock } from './account-list-format'
import { mutateDataAccount } from './data-account-commands'

export type ProviderAccountAgent = 'claude' | 'codex'

type ProviderAccountsSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
}

const PROVIDER_LABELS: Record<ProviderAccountAgent, string> = { claude: 'Claude', codex: 'Codex' }

/** Resolves `--account` to a managed account id; `system` is the user's own sign-in (null). */
export function resolveProviderAccountId(
  label: string,
  accounts: readonly { id: string; email: string }[],
  query: string
): string | null {
  if (query === 'system') {
    return null
  }
  const byId = accounts.find((account) => account.id === query)
  if (byId) {
    return byId.id
  }
  const byEmail = accounts.filter((account) => account.email.toLowerCase() === query.toLowerCase())
  if (byEmail.length === 1) {
    return byEmail[0].id
  }
  if (byEmail.length > 1) {
    // Why: one email can sign into several organizations; picking one would run the wrong subscription.
    throw new RuntimeClientError(
      'invalid_argument',
      `${query} matches ${byEmail.length} ${label} accounts. Pass one of these ids instead: ${byEmail
        .map((account) => account.id)
        .join(', ')}.`
    )
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `No managed ${label} account matches "${query}". Run \`orca account list\` to see ids and emails.`
  )
}

/** `orca account select`: Claude and Codex switch the host account; OpenCode and Devin pick a profile. */
export async function selectAgentAccount(ctx: HandlerContext): Promise<void> {
  const agent = ctx.flags.get('agent')
  await (agent === 'claude' || agent === 'codex'
    ? selectProviderAccount(ctx, agent)
    : mutateDataAccount(ctx, 'select'))
}

/** Switches the host's active Claude or Codex account, as the status-bar switcher does. */
async function selectProviderAccount(
  ctx: HandlerContext,
  agent: ProviderAccountAgent
): Promise<void> {
  const query = ctx.flags.get('account')
  if (typeof query !== 'string' || !query.trim()) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use --account <id|email> (system for your own sign-in outside Orca).'
    )
  }
  const label = PROVIDER_LABELS[agent]
  const wslTarget = getWslAccountTarget(ctx.cwd)
  if (agent === 'claude' && wslTarget && query.trim() === 'system') {
    // Why: accounts.selectClaude has no target, so `system` would reset the Windows host instead.
    throw new RuntimeClientError(
      'invalid_argument',
      'Selecting the Claude system default for a WSL distro is not supported from the CLI. Use the account switcher in Orca.'
    )
  }
  const snapshot = await ctx.client.call<ProviderAccountsSnapshot>('accounts.list', {
    refreshUsage: false
  })
  const accountId = resolveProviderAccountId(label, snapshot.result[agent].accounts, query.trim())
  const [method, params] =
    agent === 'claude'
      ? ['accounts.selectClaude', { accountId }]
      : wslTarget
        ? ['accounts.selectCodexForTarget', { accountId, target: wslTarget }]
        : ['accounts.selectCodex', { accountId }]
  const result = await ctx.client.call<ClaudeRateLimitAccountsState | CodexRateLimitAccountsState>(
    method,
    params
  )
  printResult(result, ctx.json, (state) => formatAccountsBlock(label, state))
}
