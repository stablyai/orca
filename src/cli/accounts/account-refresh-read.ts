import type {
  ProviderRateLimits,
  RateLimitState
} from '../../shared/agent-usage/rate-limits/rate-limit-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  ManagedDataAccountsState
} from '../../shared/agent-accounts/managed-account-types'
import type { AntigravityAccountState } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { printResult } from '../output/command-result-output'
import type { RuntimeClient } from '../runtime/client'
import { formatProviderUsage } from './account-list-format'

type RefreshProvider = 'claude' | 'codex'
type ProviderState = ClaudeRateLimitAccountsState | CodexRateLimitAccountsState

export type AccountsListSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  opencode?: ManagedDataAccountsState
  devin?: ManagedDataAccountsState
  antigravity?: AntigravityAccountState
  rateLimits?: RateLimitState
}

function isProviderRateLimits(value: unknown): value is ProviderRateLimits {
  return (
    typeof value === 'object' &&
    value !== null &&
    'updatedAt' in value &&
    'status' in value &&
    'error' in value
  )
}

// No successful reading exists, so 0 is the only honest updatedAt.
function failedLimits(provider: RefreshProvider, message: string): ProviderRateLimits {
  return { provider, session: null, weekly: null, updatedAt: 0, status: 'error', error: message }
}

function withRefreshError(
  rateLimits: RateLimitState | undefined,
  message: string,
  provider?: RefreshProvider
): RateLimitState | undefined {
  if (!rateLimits) {
    return rateLimits
  }
  const next = { ...rateLimits }
  for (const [key, limits] of Object.entries(next)) {
    if ((provider !== undefined && key !== provider) || !isProviderRateLimits(limits)) {
      continue
    }
    Object.assign(next, { [key]: { ...limits, status: 'error', error: message } })
  }
  for (const key of ['claude', 'codex'] as const) {
    if ((provider === undefined || provider === key) && !isProviderRateLimits(next[key])) {
      next[key] = failedLimits(key, message)
    }
  }
  return next
}

/** A failed forced refresh falls back to cached usage, recording the failure per provider. */
export async function readAccountsSnapshot<TResult extends AccountsListSnapshot>(
  client: RuntimeClient,
  refresh: boolean,
  params: Record<string, unknown>,
  provider?: RefreshProvider
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    return await client.call<TResult>('accounts.list', { ...params, refreshUsage: refresh })
  } catch (error) {
    if (!refresh) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    const cached = await client.call<TResult>('accounts.list', { ...params, refreshUsage: false })
    const result = {
      ...cached.result,
      rateLimits: withRefreshError(cached.result.rateLimits, message, provider)
    }
    if (provider) {
      Object.assign(result[provider], { status: 'error', error: message })
    }
    console.warn(`[account] Usage refresh failed: ${message}; showing cached usage.`)
    return { ...cached, result }
  }
}

/** Forced agent lists carry the selected provider's usage; unforced output stays unchanged. */
export function printProviderAccounts(
  response: RuntimeRpcSuccess<AccountsListSnapshot>,
  provider: RefreshProvider,
  refresh: boolean,
  json: boolean,
  format: (state: ProviderState) => string
): void {
  const state = response.result[provider]
  if (!refresh) {
    printResult({ ...response, result: state }, json, format)
    return
  }
  const rateLimits = response.result.rateLimits ?? null
  printResult(
    { ...response, result: { ...state, rateLimits } },
    json,
    (value) => format(value) + formatProviderUsage(rateLimits?.[provider] ?? null)
  )
}
