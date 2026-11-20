import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../shared/agent-usage/rate-limits/rate-limit-types'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgentEnabled } from '../../shared/agent-launch/catalog/tui-agent-selection'
import { detectInstalledAgents } from '../preflight/installed-agent-detection'
import { isWslDistroRunningForBackgroundWork } from '../wsl/discovery/wsl-background-distro-gate'

type Provider = ProviderRateLimits['provider']
export type UsageProviderAvailabilityResolver = (
  provider: Provider,
  signal: AbortSignal,
  target?: RateLimitRuntimeTarget
) => Promise<boolean>

const PROVIDER_AGENTS: Record<Provider, readonly TuiAgent[]> = {
  claude: ['claude', 'claude-agent-teams'],
  codex: ['codex'],
  gemini: ['gemini'],
  'opencode-go': ['opencode', 'opencode2'],
  kimi: ['kimi'],
  antigravity: ['antigravity'],
  // These account meters use explicitly saved plan credentials independently of a CLI.
  minimax: [],
  grok: ['grok'],
  cursor: ['cursor'],
  zcode: ['zcode'],
  muse: ['muse']
}

/** One local inventory per execution target and fetch cycle; no timer or workspace scan. */
export function createUsageProviderAvailabilityResolver(
  getSettings: () => Pick<GlobalSettings, 'disabledTuiAgents' | 'agentCmdOverrides'>
): UsageProviderAvailabilityResolver {
  const inventories = new WeakMap<AbortSignal, Map<string, Promise<readonly string[]>>>()
  return async (provider, signal, target) => {
    const agents = PROVIDER_AGENTS[provider]
    if (agents.length === 0) {
      return !signal.aborted
    }
    const enabled = () =>
      agents.filter((agent) => isTuiAgentEnabled(agent, getSettings().disabledTuiAgents))
    if (signal.aborted || enabled().length === 0) {
      return false
    }
    const wsl = process.platform === 'win32' && target?.runtime === 'wsl'
    const key = wsl ? `wsl:${target.wslDistro ?? ''}` : 'host'
    let cycle = inventories.get(signal)
    if (!cycle) {
      cycle = new Map()
      inventories.set(signal, cycle)
    }
    let inventory = cycle.get(key)
    if (!inventory) {
      inventory = (async () => {
        if (wsl && !(await isWslDistroRunningForBackgroundWork(target.wslDistro ?? undefined))) {
          return []
        }
        return detectInstalledAgents(
          wsl ? { wslDistro: target.wslDistro, wslDefault: !target.wslDistro } : undefined,
          getSettings()
        )
      })().catch((error: unknown) => {
        console.warn('[rate-limits] Agent availability could not be verified:', error)
        return []
      })
      cycle.set(key, inventory)
    }
    const installed = await inventory
    return !signal.aborted && enabled().some((agent) => installed.includes(agent))
  }
}
