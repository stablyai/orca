import * as z from 'zod'
import { getUsageWindowSections } from '../../../src/shared/agent-usage/display/usage-provider-windows'
import {
  parseUsageHistory,
  usageHistoryKey,
  type UsageHistorySample
} from '../../../src/shared/agent-usage/rate-limits/usage-window-history'
import {
  getActiveProviderRateLimits,
  getOtherUsageProviders
} from '../accounts/usage/usage-selectors'
import type {
  AccountsSnapshot,
  ProviderRateLimits,
  RateLimitWindow
} from '../accounts/accounts-snapshot'

// Only agents that spend the provider plan the desktop polls; others (e.g. aider, openclaude) bring their own keys.
const AGENT_USAGE_PROVIDERS = new Map<string, string>([
  ['claude', 'claude'],
  ['claude-agent-teams', 'claude'],
  ['codex', 'codex'],
  ['gemini', 'gemini'],
  ['opencode', 'opencode-go'],
  ['opencode2', 'opencode-go'],
  ['kimi', 'kimi'],
  ['antigravity', 'antigravity'],
  ['grok', 'grok'],
  ['cursor', 'cursor'],
  ['zcode', 'zcode'],
  ['muse', 'muse']
])

export type ComposerUsageWindowChoice = 'session' | 'weekly'

export type UsageWindowEntry = {
  id: string
  kind: 'session' | 'weekly' | 'fableWeekly' | 'monthly' | 'bucket'
  /** A bucket's own name; null for the standard windows. */
  name: string | null
  window: RateLimitWindow
}

export type AgentUsage = {
  /** The provider id the host reports, e.g. "opencode-go". */
  provider: string
  windows: UsageWindowEntry[]
  /** The host's note on this reading, e.g. that no window has usage yet. */
  notice?: string | null
}

export function usageProviderForAgent(agent: string | null | undefined): string | null {
  return (agent && AGENT_USAGE_PROVIDERS.get(agent)) || null
}

function listUsageWindows(limits: ProviderRateLimits): UsageWindowEntry[] {
  return getUsageWindowSections(limits).flatMap((section, index): UsageWindowEntry[] => {
    if (!section.window) {
      return []
    }
    if (section.kind === 'bucket') {
      return [
        {
          id: `bucket:${index}:${section.name}`,
          kind: 'bucket',
          name: section.name,
          window: section.window
        }
      ]
    }
    // Cursor's plan total and zcode's MCP quota read as the provider's monthly window.
    const kind = section.kind === 'plan' || section.kind === 'mcp' ? 'monthly' : section.kind
    return [{ id: kind, kind, name: null, window: section.window }]
  })
}

/** One provider's usage windows, or null when the host reports none for it. */
export function selectProviderUsage(
  snapshot: AccountsSnapshot | null,
  provider: string
): AgentUsage | null {
  if (!snapshot) {
    return null
  }
  const limits =
    provider === 'claude' || provider === 'codex'
      ? getActiveProviderRateLimits(snapshot, provider)
      : getOtherUsageProviders(snapshot).find((entry) => entry.provider === provider)
  const windows = limits ? listUsageWindows(limits) : []
  return windows.length > 0 ? { provider, windows, notice: limits?.notice ?? null } : null
}

/** The tab agent's provider usage, or null when the meter should stay hidden. */
export function selectAgentUsage(
  snapshot: AccountsSnapshot | null,
  agent: string | null | undefined
): AgentUsage | null {
  const provider = usageProviderForAgent(agent)
  return provider ? selectProviderUsage(snapshot, provider) : null
}

const PROVIDER_ORDER: readonly string[] = [
  'claude',
  'codex',
  'gemini',
  'opencode-go',
  'kimi',
  'antigravity',
  'grok',
  'cursor',
  'minimax',
  'zcode',
  'muse'
]

/** Every provider with windows, the given one first, for the sheet's provider tabs. */
export function listProviderUsages(snapshot: AccountsSnapshot | null, first: string): AgentUsage[] {
  if (!snapshot) {
    return []
  }
  const known = [first, ...PROVIDER_ORDER.filter((provider) => provider !== first)]
  const extra = getOtherUsageProviders(snapshot)
    .map((limits) => limits.provider)
    .filter((provider) => !known.includes(provider))
  return [...known, ...extra].flatMap((provider) => {
    const usage = selectProviderUsage(snapshot, provider)
    return usage ? [usage] : []
  })
}

const UsageHistoryCarrierSchema = z.object({ usageHistory: z.unknown().optional() })

/** The host's used-percent samples for one window, oldest first; empty on hosts that keep none. */
export function readUsageWindowHistory(
  snapshot: AccountsSnapshot | null,
  provider: string,
  windowId: string
): UsageHistorySample[] {
  const carrier = UsageHistoryCarrierSchema.safeParse(snapshot?.rateLimits)
  if (!carrier.success) {
    return []
  }
  const series = parseUsageHistory(carrier.data.usageHistory)[usageHistoryKey(provider, windowId)]
  // The phone's Hermes engine lacks toSorted.
  return series ? [...series.samples].sort((a, b) => a.at - b.at) : []
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

/** The 5-hour vs weekly choice. Hidden unless this usage includes a 5-hour window to switch to. */
export function composerUsageWindowToggleChoices(
  windows: readonly UsageWindowEntry[]
): readonly ComposerUsageWindowChoice[] {
  const hasSession = windows.some((entry) => entry.kind === 'session')
  const hasWeekly = windows.some((entry) => entry.kind === 'weekly')
  return hasSession && hasWeekly ? ['session', 'weekly'] : []
}

/** "5h", "7d", "30d": the window's length, which is what users call these limits. */
export function formatUsageWindowLength(windowMinutes: number): string {
  return windowMinutes < 1440
    ? `${Math.max(1, Math.round(windowMinutes / 60))}h`
    : `${Math.round(windowMinutes / 1440)}d`
}
