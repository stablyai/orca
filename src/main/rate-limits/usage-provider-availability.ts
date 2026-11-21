import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../shared/agent-usage/rate-limits/rate-limit-types'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgentEnabled } from '../../shared/agent-launch/catalog/tui-agent-selection'
import { loginShellEnvironmentRevision } from '../startup/shell-environment/login-shell-environment'
import { managedRuntimeReleasesRevision } from '../node-runtime/managed-runtime-installation'
import { agentsRefreshedOnHostRevision } from '../preflight/agents-refreshed-on-host'
import { detectInstalledAgents } from '../preflight/installed-agent-detection'
import { isWslDistroRunningForBackgroundWork } from '../wsl/discovery/wsl-background-distro-gate'

type Provider = ProviderRateLimits['provider']
export type UsageProviderAvailabilityResolver = (
  provider: Provider,
  signal: AbortSignal,
  target?: RateLimitRuntimeTarget,
  accountConfigured?: boolean
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

/** Reuse each host inventory until its settings, shell PATH, installations, or explicit refresh change. */
export function createUsageProviderAvailabilityResolver(
  getSettings: () => Pick<GlobalSettings, 'disabledTuiAgents' | 'agentCmdOverrides'>
): UsageProviderAvailabilityResolver {
  const inventories = new Map<string, Promise<readonly string[]>>()
  const runningChecks = new WeakMap<AbortSignal, Map<string, Promise<boolean>>>()
  const signature = () => {
    const settings = getSettings()
    return JSON.stringify([
      settings.disabledTuiAgents,
      settings.agentCmdOverrides,
      process.env.PATH,
      process.env.PATHEXT,
      loginShellEnvironmentRevision(),
      managedRuntimeReleasesRevision(),
      agentsRefreshedOnHostRevision()
    ])
  }
  let cachedSignature: string | undefined
  return async (provider, signal, target, accountConfigured = false) => {
    const agents = PROVIDER_AGENTS[provider]
    if (agents.length === 0) {
      return !signal.aborted
    }
    const enabled = () =>
      agents.filter((agent) => isTuiAgentEnabled(agent, getSettings().disabledTuiAgents))
    if (signal.aborted || enabled().length === 0) {
      return false
    }
    if (accountConfigured) {
      return true
    }
    const currentSignature = signature()
    if (cachedSignature !== currentSignature) {
      inventories.clear()
      cachedSignature = currentSignature
    }
    const wsl = process.platform === 'win32' && target?.runtime === 'wsl'
    const key = wsl ? `wsl:${target.wslDistro ?? ''}` : 'host'
    if (wsl) {
      let checks = runningChecks.get(signal)
      if (!checks) {
        checks = new Map()
        runningChecks.set(signal, checks)
      }
      let running = checks.get(key)
      if (!running) {
        running = isWslDistroRunningForBackgroundWork(target.wslDistro)
        checks.set(key, running)
      }
      if (!(await running) || signal.aborted) {
        return false
      }
    }
    let inventory = inventories.get(key)
    if (!inventory) {
      inventory = (async () => {
        return detectInstalledAgents(
          wsl ? { wslDistro: target.wslDistro, wslDefault: !target.wslDistro } : undefined,
          getSettings()
        )
      })().catch((error: unknown) => {
        if (inventories.get(key) === inventory) {
          inventories.delete(key)
        }
        console.warn('[rate-limits] Agent availability could not be verified:', error)
        return []
      })
      if (inventories.size >= 128) {
        inventories.clear()
      }
      inventories.set(key, inventory)
    }
    const installed = await inventory
    return (
      !signal.aborted &&
      signature() === currentSignature &&
      enabled().some((agent) => installed.includes(agent))
    )
  }
}
