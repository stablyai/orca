import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'
import { detectLocalTuiAgentCliPresence } from './local-agent-cli-presence'

/** Agents whose plugins a plain shell may install, for a CLI the user types later. */
const BARE_SHELL_PLUGIN_AGENTS = ['opencode', 'opencode2', 'pi', 'omp'] as const

const PRESENCE_TTL_MS = 30_000
const FIRST_PROBE_WAIT_MS = 200

type OverrideSettings = Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> | null | undefined

type PresenceEntry = {
  key: string
  at: number
  agents: Promise<ReadonlySet<TuiAgent>>
  settled?: ReadonlySet<TuiAgent>
}

let cached: PresenceEntry | null = null

async function detect(settings: OverrideSettings): Promise<ReadonlySet<TuiAgent>> {
  const presence = await detectLocalTuiAgentCliPresence(BARE_SHELL_PLUGIN_AGENTS, settings, {
    shouldHydrateShellPath: getAppEnvironment().isPackaged()
  })
  return new Set(BARE_SHELL_PLUGIN_AGENTS.filter((agent) => presence[agent]?.state === 'found'))
}

/**
 * CLIs on this host's PATH; plain shells install plugins only for these (#43445).
 * Stale results serve while a refresh runs; a slow first probe yields an empty set.
 */
export function detectBareShellPluginAgentsOnPath(
  settings: OverrideSettings
): Promise<ReadonlySet<TuiAgent>> {
  const key = JSON.stringify(BARE_SHELL_PLUGIN_AGENTS.map((a) => settings?.agentCmdOverrides?.[a]))
  const now = Date.now()
  if (!cached || cached.key !== key || now - cached.at > PRESENCE_TTL_MS) {
    const entry: PresenceEntry = {
      key,
      at: now,
      settled: cached?.key === key ? cached.settled : undefined,
      agents: detect(settings).catch((error: unknown) => {
        console.warn(
          '[agent-hooks] Agent CLI detection failed; skipping plain-shell plugins:',
          error
        )
        return new Set<TuiAgent>()
      })
    }
    void entry.agents.then((agents) => {
      entry.settled = agents
    })
    cached = entry
  }
  return cached.settled
    ? Promise.resolve(cached.settled)
    : withTimeout(cached.agents, FIRST_PROBE_WAIT_MS, new Set<TuiAgent>())
}
