import {
  ProviderRateLimitsSchema,
  type AccountsSnapshot,
  type ProviderRateLimits,
  type RateLimitWindow
} from '../components/accounts-snapshot'

/** `snapshot.rateLimits` keys whose quota a coding agent draws on. */
export type UsageProviderKey =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencodeGo'
  | 'kimi'
  | 'antigravity'
  | 'grok'
  | 'cursor'

// Only agents that spend the provider plan the desktop polls; others (e.g. aider, openclaude) bring their own keys.
const AGENT_USAGE_PROVIDERS = new Map<string, UsageProviderKey>([
  ['claude', 'claude'],
  ['claude-agent-teams', 'claude'],
  ['codex', 'codex'],
  ['gemini', 'gemini'],
  ['opencode', 'opencodeGo'],
  ['opencode2', 'opencodeGo'],
  ['kimi', 'kimi'],
  ['antigravity', 'antigravity'],
  ['grok', 'grok'],
  ['cursor', 'cursor']
])

const PROVIDER_IDS: Record<UsageProviderKey, ProviderRateLimits['provider']> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencodeGo: 'opencode-go',
  kimi: 'kimi',
  antigravity: 'antigravity',
  grok: 'grok',
  cursor: 'cursor'
}

export const USAGE_PROVIDER_NAMES: Record<UsageProviderKey, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencodeGo: 'OpenCode Go',
  kimi: 'Kimi',
  antigravity: 'Antigravity',
  grok: 'Grok',
  cursor: 'Cursor'
}

export type ComposerUsageWindowChoice = 'session' | 'weekly'

export type UsageWindowEntry = {
  id: string
  kind: 'session' | 'weekly' | 'fableWeekly' | 'monthly' | 'bucket'
  /** A bucket's own name; null for the standard windows. */
  name: string | null
  window: RateLimitWindow
}

export type AgentUsage = {
  provider: UsageProviderKey
  windows: UsageWindowEntry[]
}

export function usageProviderForAgent(agent: string | null | undefined): UsageProviderKey | null {
  return (agent && AGENT_USAGE_PROVIDERS.get(agent)) || null
}

// Providers beyond Claude/Codex ride the snapshot's passthrough fields, so validate them here.
function readProviderLimits(
  snapshot: AccountsSnapshot,
  provider: UsageProviderKey
): ProviderRateLimits | null {
  const raw: unknown = snapshot.rateLimits[provider]
  const parsed = ProviderRateLimitsSchema.safeParse(raw)
  return parsed.success && parsed.data.provider === PROVIDER_IDS[provider] ? parsed.data : null
}

export function listUsageWindows(limits: ProviderRateLimits): UsageWindowEntry[] {
  const standard = (['session', 'weekly', 'fableWeekly', 'monthly'] as const).flatMap((kind) => {
    const window = limits[kind]
    return window ? [{ id: kind, kind, name: null, window }] : []
  })
  const buckets = (limits.buckets ?? []).map((bucket, index) => ({
    id: `bucket:${index}:${bucket.name}`,
    kind: 'bucket' as const,
    name: bucket.name,
    window: bucket
  }))
  return [...standard, ...buckets]
}

/** The tab agent's provider usage, or null when the meter should stay hidden. */
export function selectAgentUsage(
  snapshot: AccountsSnapshot | null,
  agent: string | null | undefined
): AgentUsage | null {
  const provider = usageProviderForAgent(agent)
  if (!snapshot || !provider) {
    return null
  }
  const limits = readProviderLimits(snapshot, provider)
  const windows = limits ? listUsageWindows(limits) : []
  return windows.length > 0 ? { provider, windows } : null
}

// Fall back to the other standard window, then whatever the provider reports (monthly-only plans).
export function pickComposerUsageWindow(
  windows: readonly UsageWindowEntry[],
  choice: ComposerUsageWindowChoice
): UsageWindowEntry | null {
  const other = choice === 'session' ? 'weekly' : 'session'
  return (
    windows.find((entry) => entry.kind === choice) ??
    windows.find((entry) => entry.kind === other) ??
    windows[0] ??
    null
  )
}

/** "5h", "7d", "30d": the window's length, which is what users call these limits. */
export function formatUsageWindowLength(windowMinutes: number): string {
  return windowMinutes < 1440
    ? `${Math.max(1, Math.round(windowMinutes / 60))}h`
    : `${Math.round(windowMinutes / 1440)}d`
}
