import { getUsageWindowSections } from '../../../src/shared/usage-provider-windows'
import {
  getActiveProviderRateLimits,
  getOtherUsageProviders
} from '../components/account-usage-state'
import type {
  AccountsSnapshot,
  ProviderRateLimits,
  RateLimitWindow
} from '../components/accounts-snapshot'

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
  ['cursor', 'cursor']
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

/** The tab agent's provider usage, or null when the meter should stay hidden. */
export function selectAgentUsage(
  snapshot: AccountsSnapshot | null,
  agent: string | null | undefined
): AgentUsage | null {
  const provider = usageProviderForAgent(agent)
  if (!snapshot || !provider) {
    return null
  }
  const limits =
    provider === 'claude' || provider === 'codex'
      ? getActiveProviderRateLimits(snapshot, provider)
      : getOtherUsageProviders(snapshot).find((entry) => entry.provider === provider)
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
