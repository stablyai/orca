import {
  ProviderRateLimitsSchema,
  type AccountsSnapshot,
  type ProviderRateLimits
} from './accounts-snapshot'
import { hasActiveProviderUsage, type UsageWindowKey } from './account-usage-state'

// Why: mirrors getProviderDisplayName in the desktop status bar; key is the
// RateLimitState field, provider is the identity the host stamps on it.
export const EXTRA_USAGE_PROVIDERS = [
  { key: 'grok', provider: 'grok', title: 'Grok' },
  { key: 'antigravity', provider: 'antigravity', title: 'Antigravity' },
  { key: 'gemini', provider: 'gemini', title: 'Gemini' },
  { key: 'opencodeGo', provider: 'opencode-go', title: 'OpenCode Go' },
  { key: 'kimi', provider: 'kimi', title: 'Kimi' },
  { key: 'minimax', provider: 'minimax', title: 'MiniMax' }
] as const

export type ExtraUsageProviderKey = (typeof EXTRA_USAGE_PROVIDERS)[number]['key']

export type ExtraProviderUsage = {
  key: ExtraUsageProviderKey
  title: string
  limits: ProviderRateLimits
  windows: UsageWindowKey[]
}

const WINDOW_ORDER: UsageWindowKey[] = ['session', 'weekly', 'monthly']

// Why: these entries sit outside the strict snapshot schema, so each one is
// decoded on its own — a malformed or foreign entry hides only that provider
// instead of failing the Claude/Codex sections closed.
export function getExtraProviderUsage(snapshot: AccountsSnapshot): ExtraProviderUsage[] {
  const rateLimits: Record<string, unknown> = snapshot.rateLimits
  const result: ExtraProviderUsage[] = []
  for (const { key, provider, title } of EXTRA_USAGE_PROVIDERS) {
    const parsed = ProviderRateLimitsSchema.safeParse(rateLimits[key])
    if (!parsed.success || parsed.data.provider !== provider) {
      continue
    }
    const limits = parsed.data
    if (!hasActiveProviderUsage(limits)) {
      continue
    }
    const windows = WINDOW_ORDER.filter((windowKey) => limits[windowKey] != null)
    result.push({ key, title, limits, windows })
  }
  return result
}
