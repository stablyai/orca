import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { InFlightPromiseDedupe } from '../../../../shared/in-flight-promise-dedupe'
import { onAgentsRefreshedOnHost } from '../../../preflight/workspace-agent-detection'
import type { DiscoverCommitMessageModelsResult } from '../../../text-generation/source-control-text-generation-types'

// Phones list these on every chat open; other agents' lists have their own catalog owners.
// Each maps to the config-dir var that picks its login (see prepareLocalCommitMessageAgentEnv).
const ACCOUNT_DIR_VAR: Partial<Record<TuiAgent, string>> = {
  omp: 'PI_CODING_AGENT_DIR',
  grok: 'GROK_HOME'
}
const TTL_MS = 10 * 60_000
const MAX_ENTRIES = 32

const cache = new Map<string, { result: DiscoverCommitMessageModelsResult; expiresAt: number }>()
const inFlight = new InFlightPromiseDedupe<DiscoverCommitMessageModelsResult>()
let generation = 0

// An agent refresh is how a user says the CLI or its login changed.
onAgentsRefreshedOnHost(() => {
  generation += 1
  cache.clear()
  inFlight.clear()
})

export type ModelDiscoveryCacheInput = {
  agentId: TuiAgent
  agentCommandOverride: string | undefined
  env: NodeJS.ProcessEnv | undefined
  wsl: { cwd: string; wslDistro: string } | null
}

/** Reuse a probe-confirmed OMP or Grok list for 10 min; other agents and failures always probe. */
export function discoverModelsWithHostCache(
  input: ModelDiscoveryCacheInput,
  discover: () => Promise<DiscoverCommitMessageModelsResult>
): Promise<DiscoverCommitMessageModelsResult> {
  const accountDirVar = ACCOUNT_DIR_VAR[input.agentId]
  if (!accountDirVar) {
    return discover()
  }
  // Not the whole env: the login-shell capture differs on every read (e.g. STARSHIP_SESSION_KEY).
  const key = JSON.stringify([
    input.agentId,
    input.agentCommandOverride ?? null,
    input.wsl,
    input.env?.[accountDirVar] ?? null
  ])
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.result)
  }
  return inFlight.run(key, async () => {
    const startedIn = generation
    const result = await discover()
    // A refresh during the probe makes its answer stale.
    if (result.success && result.catalogOrigin === 'probe' && startedIn === generation) {
      cache.delete(key)
      const oldest = cache.keys().next()
      if (!oldest.done && cache.size >= MAX_ENTRIES) {
        cache.delete(oldest.value)
      }
      cache.set(key, { result, expiresAt: Date.now() + TTL_MS })
    }
    return result
  })
}
