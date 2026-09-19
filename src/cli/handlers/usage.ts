import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import type {
  ProviderRateLimits,
  RateLimitState,
  RateLimitWindow
} from '../../shared/rate-limit-types'

// Why: accounts.list already returns rateLimits alongside the account lists; usage
// only needs that slice. A structural subset keeps the CLI free of a main import.
type UsageSnapshot = { rateLimits: RateLimitState }

type ProviderUsageEntry = { provider: string; usage: ProviderRateLimits | null }
type UsagePayload = { providers: ProviderUsageEntry[] }

// Why: the public provider names map to camelCased RateLimitState fields; a getter
// per provider avoids a keyof cast that AGENTS.md would require a SAFETY note for.
const PROVIDERS: { name: string; get: (state: RateLimitState) => ProviderRateLimits | null }[] = [
  { name: 'claude', get: (s) => s.claude },
  { name: 'codex', get: (s) => s.codex },
  { name: 'gemini', get: (s) => s.gemini },
  { name: 'opencode-go', get: (s) => s.opencodeGo },
  { name: 'kimi', get: (s) => s.kimi },
  { name: 'minimax', get: (s) => s.minimax },
  { name: 'grok', get: (s) => s.grok },
  { name: 'antigravity', get: (s) => s.antigravity }
]

function formatWindow(label: string, window: RateLimitWindow | null | undefined): string | null {
  if (!window) {
    return null
  }
  const used = Math.round(window.usedPercent)
  const left = Math.max(0, 100 - used)
  const reset = window.resetDescription ? `, resets ${window.resetDescription}` : ''
  return `${label} ${used}% used (${left}% left)${reset}`
}

function formatProviderUsage(provider: string, usage: ProviderRateLimits | null): string {
  if (!usage) {
    return `${provider}: not configured`
  }
  if (usage.status === 'error' || usage.error) {
    return `${provider}: ${usage.error ?? 'usage unavailable'} (status: ${usage.status})`
  }
  const windows = [
    formatWindow('5h', usage.session),
    formatWindow('7d', usage.weekly),
    formatWindow('Fable 7d', usage.fableWeekly),
    formatWindow('30d', usage.monthly),
    // Gemini reports per-model quota as named buckets; each is a RateLimitWindow + name.
    ...(usage.buckets ?? []).map((bucket) => formatWindow(bucket.name, bucket))
  ].filter((line): line is string => line !== null)
  const extras: string[] = []
  if (usage.planType) {
    extras.push(`plan: ${usage.planType}`)
  }
  if (usage.rateLimitResetCredits && usage.rateLimitResetCredits.availableCount > 0) {
    extras.push(`reset credits: ${usage.rateLimitResetCredits.availableCount}`)
  }
  const body = windows.length > 0 ? windows.join('  |  ') : 'no window data'
  const suffix = extras.length > 0 ? `  [${extras.join(', ')}]` : ''
  return `${provider}: ${body}${suffix}`
}

function formatUsage(payload: UsagePayload): string {
  return payload.providers
    .map((entry) => formatProviderUsage(entry.provider, entry.usage))
    .join('\n')
}

/** CLI handler for `orca usage [provider]`: reports remaining provider quota to agents. */
export const USAGE_HANDLERS: Record<string, CommandHandler> = {
  usage: async ({ client, json, flags }) => {
    const providerFlag = flags.get('provider')
    // Why: a valueless positional cannot occur, but a `--provider` with no value
    // parses as boolean true; reject it rather than silently listing every provider.
    if (providerFlag !== undefined && typeof providerFlag !== 'string') {
      throw new RuntimeClientError(
        'invalid_argument',
        `Missing a provider name. Use one of: ${PROVIDERS.map((p) => p.name).join(', ')}.`
      )
    }
    const selected = providerFlag ? PROVIDERS.filter((p) => p.name === providerFlag) : PROVIDERS
    if (providerFlag && selected.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown provider "${providerFlag}". Known providers: ${PROVIDERS.map((p) => p.name).join(', ')}.`
      )
    }
    // Why: cached by default so an orchestration loop polling usage cannot trip the
    // provider endpoint's rate limit; --refresh opts into a live fetch when needed.
    const refreshUsage = flags.get('refresh') === true
    const result = await client.call<UsageSnapshot>('accounts.list', { refreshUsage })
    const providers = selected.map((p) => ({
      provider: p.name,
      usage: p.get(result.result.rateLimits)
    }))
    printResult({ ...result, result: { providers } }, json, formatUsage)
  }
}
