import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY } from '../../shared/account-runtime-capabilities'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../shared/antigravity-account-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { getWslAccountTarget } from './account-wsl-location'
import {
  formatAccountsBlock,
  formatAntigravityAccounts,
  formatDataAccounts
} from './account-list-format'
import { assertDataAccountsSupported, listDataAccounts } from './data-account-commands'

const ACCOUNT_AGENTS = ['claude', 'codex', 'opencode', 'devin', 'antigravity'] as const
type AccountAgent = (typeof ACCOUNT_AGENTS)[number]

const AGENT_FLAG_HINT = 'Use --agent claude|codex|opencode|devin|antigravity.'
const ACCOUNT_FLAG_HINT = 'Use --account <id|email|label|system> from `orca account list`.'

/** One saved account and the names `--account` may call it by (email, label, subject). */
type AccountChoice = { id: string; names: readonly (string | null | undefined)[] }

/**
 * Every provider with saved accounts, behind one shape so select and rm resolve
 * `--account` the same way. Each operation prints its own result, which keeps the
 * per-provider state types out of the shared code.
 */
type ProviderAccounts = {
  label: string
  /** Whether `system` (the provider's own sign-in, outside Orca's vault) can be selected. */
  hasSystemDefault: boolean
  choices: () => Promise<AccountChoice[]>
  list: () => Promise<void>
  select: (accountId: string | null) => Promise<void>
  remove: (accountId: string) => Promise<void>
}

type ClaudeCodexSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
}

function emailChoices(state: { accounts: readonly { id: string; email: string }[] }) {
  return state.accounts.map((account) => ({ id: account.id, names: [account.email] }))
}

function claudeAccounts({ client, json }: HandlerContext): ProviderAccounts {
  const read = () => client.call<ClaudeCodexSnapshot>('accounts.list', { refreshUsage: false })
  const print = async (method: string, accountId: string | null) =>
    printResult(
      await client.call<ClaudeRateLimitAccountsState>(method, { accountId }),
      json,
      (state) => formatAccountsBlock('Claude', state)
    )
  return {
    label: 'Claude',
    hasSystemDefault: true,
    choices: async () => emailChoices((await read()).result.claude),
    list: async () => {
      const response = await read()
      printResult({ ...response, result: response.result.claude }, json, (state) =>
        formatAccountsBlock('Claude', state)
      )
    },
    select: (accountId) => print('accounts.selectClaude', accountId),
    remove: (accountId) => print('accounts.removeClaude', accountId)
  }
}

function codexAccounts({ client, cwd, json }: HandlerContext): ProviderAccounts {
  const read = () => client.call<ClaudeCodexSnapshot>('accounts.list', { refreshUsage: false })
  const format = (state: CodexRateLimitAccountsState) => formatAccountsBlock('Codex', state)
  const wslTarget = getWslAccountTarget(cwd)
  return {
    label: 'Codex',
    hasSystemDefault: true,
    choices: async () => emailChoices((await read()).result.codex),
    list: async () => {
      const response = await read()
      printResult({ ...response, result: response.result.codex }, json, format)
    },
    // Why ForTarget from WSL: plain selectCodex always writes the Windows host slot.
    select: async (accountId) =>
      printResult(
        wslTarget
          ? await client.call<CodexRateLimitAccountsState>('accounts.selectCodexForTarget', {
              accountId,
              target: wslTarget
            })
          : await client.call<CodexRateLimitAccountsState>('accounts.selectCodex', { accountId }),
        json,
        format
      ),
    remove: async (accountId) =>
      printResult(
        await client.call<CodexRateLimitAccountsState>('accounts.removeCodex', { accountId }),
        json,
        format
      )
  }
}

function dataAccounts(ctx: HandlerContext, provider: ManagedDataAccountProvider): ProviderAccounts {
  const { client, json } = ctx
  const label = provider === 'opencode' ? 'OpenCode' : 'Devin'
  const read = async () => {
    await assertDataAccountsSupported(ctx)
    const response =
      await client.call<Partial<Record<ManagedDataAccountProvider, ManagedDataAccountsState>>>(
        'accounts.listData'
      )
    const state = response.result[provider]
    if (!state) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Managed accounts are unavailable on this host.'
      )
    }
    return { ...response, result: state }
  }
  const print = async (method: string, accountId: string | null) =>
    printResult(
      await client.call<ManagedDataAccountsState>(method, { provider, accountId }),
      json,
      (state) => formatDataAccounts(label, state)
    )
  return {
    label,
    hasSystemDefault: true,
    choices: async () =>
      (await read()).result.accounts.map((account) => ({ id: account.id, names: [account.label] })),
    list: () => listDataAccounts(ctx, provider),
    select: (accountId) => print('accounts.selectData', accountId),
    remove: (accountId) => print('accounts.removeData', accountId)
  }
}

async function supportsAntigravityAccounts({ client }: HandlerContext): Promise<boolean> {
  const status = await client.call<RuntimeStatus>('status.get')
  return status.result.capabilities?.includes(ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY) ?? false
}

function antigravityTarget(cwd: string): AntigravityAccountTarget {
  return getWslAccountTarget(cwd) ?? { runtime: 'host' }
}

function antigravityAccounts(ctx: HandlerContext): ProviderAccounts {
  const { client, cwd, json } = ctx
  const target = antigravityTarget(cwd)
  const read = async () => {
    if (!(await supportsAntigravityAccounts(ctx))) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update or restart this Orca host to manage Antigravity accounts.'
      )
    }
    return client.call<AntigravityAccountState>('accounts.antigravityList', target)
  }
  const print = async (method: string, accountId: string) =>
    printResult(
      await client.call<AntigravityAccountState>(method, { target, accountId }),
      json,
      formatAntigravityAccounts
    )
  return {
    label: 'Antigravity',
    // Why: the native `agy` login is always one of the saved accounts; there is no
    // separate system sign-in to fall back to.
    hasSystemDefault: false,
    choices: async () =>
      (await read()).result.accounts.map((account) => ({
        id: account.id,
        names: [account.email, account.subject]
      })),
    list: async () => printResult(await read(), json, formatAntigravityAccounts),
    select: async (accountId) => {
      if (accountId === null) {
        throw new RuntimeClientError('invalid_argument', 'Antigravity has no system default.')
      }
      await print('accounts.antigravitySelect', accountId)
    },
    remove: (accountId) => print('accounts.antigravityRemove', accountId)
  }
}

function providerAccounts(ctx: HandlerContext, agent: AccountAgent): ProviderAccounts {
  switch (agent) {
    case 'claude':
      return claudeAccounts(ctx)
    case 'codex':
      return codexAccounts(ctx)
    case 'opencode':
    case 'devin':
      return dataAccounts(ctx, agent)
    case 'antigravity':
      return antigravityAccounts(ctx)
  }
}

function isAccountAgent(value: string): value is AccountAgent {
  return ACCOUNT_AGENTS.some((agent) => agent === value)
}

// Why required: switching or removing an account decides which subscription is billed,
// so the provider is never guessed.
function readAgentFlag(ctx: HandlerContext): AccountAgent {
  const agent = ctx.flags.get('agent')
  if (typeof agent !== 'string') {
    throw new RuntimeClientError('invalid_argument', AGENT_FLAG_HINT)
  }
  if (!isAccountAgent(agent)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --agent "${agent}". ${AGENT_FLAG_HINT}`
    )
  }
  return agent
}

function readAccountFlag(ctx: HandlerContext): string {
  const account = ctx.flags.get('account')
  if (typeof account !== 'string' || !account.trim()) {
    throw new RuntimeClientError('invalid_argument', ACCOUNT_FLAG_HINT)
  }
  return account.trim()
}

/**
 * Resolves `--account` to a saved account id: an exact id first, then a
 * case-insensitive email, label or subject. `system` is the provider's own sign-in
 * (null). A name shared by several accounts — one email in two organizations — is
 * refused with their ids rather than guessing which subscription to bill.
 */
export function resolveAccountId(
  label: string,
  accounts: readonly AccountChoice[],
  query: string,
  { allowSystem }: { allowSystem: boolean }
): string | null {
  if (query === 'system') {
    if (!allowSystem) {
      throw new RuntimeClientError('invalid_argument', `${label} has no system default.`)
    }
    return null
  }
  return resolveSavedAccountId(label, accounts, query)
}

function resolveSavedAccountId(
  label: string,
  accounts: readonly AccountChoice[],
  query: string
): string {
  const byId = accounts.find((account) => account.id === query)
  if (byId) {
    return byId.id
  }
  const needle = query.toLowerCase()
  const byName = accounts.filter((account) =>
    account.names.some((name) => name?.toLowerCase() === needle)
  )
  if (byName.length === 1) {
    return byName[0].id
  }
  if (byName.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Several ${label} accounts match "${query}"; pass one of their ids: ${byName
        .map((account) => account.id)
        .join(', ')}.`
    )
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `No managed ${label} account matches "${query}". Run \`orca account list\` to see the saved accounts.`
  )
}

/** `orca account select`: the account new launches of that agent use on this host. */
export async function selectAgentAccount(ctx: HandlerContext): Promise<void> {
  const agent = readAgentFlag(ctx)
  const query = readAccountFlag(ctx)
  // Why: accounts.selectClaude carries no target, so `system` from the WSL bridge
  // would reset the Windows host's selection instead of the distro's.
  if (agent === 'claude' && query === 'system' && getWslAccountTarget(ctx.cwd)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Select the Claude system default for a WSL distro in Orca Settings > AI Provider Accounts.'
    )
  }
  const provider = providerAccounts(ctx, agent)
  const accountId = resolveAccountId(provider.label, await provider.choices(), query, {
    allowSystem: provider.hasSystemDefault
  })
  await provider.select(accountId)
}

/** `orca account rm`: forgets a saved account; the provider's own sign-in is never touched. */
export async function removeAgentAccount(ctx: HandlerContext): Promise<void> {
  const agent = readAgentFlag(ctx)
  const query = readAccountFlag(ctx)
  if (query === 'system') {
    throw new RuntimeClientError(
      'invalid_argument',
      'System credentials are never removed; pass a saved account from `orca account list`.'
    )
  }
  const provider = providerAccounts(ctx, agent)
  await provider.remove(resolveSavedAccountId(provider.label, await provider.choices(), query))
}

/** `orca account list --agent <id>`: one provider's saved accounts. */
export async function listAgentAccounts(ctx: HandlerContext, agentFlag: unknown): Promise<void> {
  if (typeof agentFlag !== 'string' || !isAccountAgent(agentFlag)) {
    throw new RuntimeClientError('invalid_argument', AGENT_FLAG_HINT)
  }
  await providerAccounts(ctx, agentFlag).list()
}

/** The Antigravity block for the full `orca account list`, or null on a host that cannot read it. */
export async function readAntigravityAccountsForList(
  ctx: HandlerContext
): Promise<AntigravityAccountState | null> {
  if (!(await supportsAntigravityAccounts(ctx))) {
    return null
  }
  // Why: a host can advertise the capability yet have no native credential adapter
  // (Linux Secret Service today). The overview must still show every other provider;
  // `orca account list --agent antigravity` keeps reporting the reason.
  try {
    const response = await ctx.client.call<AntigravityAccountState>(
      'accounts.antigravityList',
      antigravityTarget(ctx.cwd)
    )
    return response.result
  } catch {
    return null
  }
}
