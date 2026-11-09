import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { InFlightPromiseDedupe, stableInFlightKey } from '../../shared/in-flight-promise-dedupe'
import { setBoundedScopeCacheEntry } from '../../shared/native-chat/native-chat-scope-cache'
import { PRIMARY_AGENT_DIR_ENV_BY_KIND } from '../../shared/pi-agent-kind'
import { onAgentsRefreshedOnHost } from '../preflight/agents-refreshed-on-host'
import type { CommitMessageModelDiscoveryLocalOptions } from './commit-message-model-discovery'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import type { DiscoverCommitMessageModelsResult } from './source-control-text-generation-types'

// Phone and desktop chat pickers list these on open; other agents' lists have their own catalog owners.
// Each maps to the config-dir var that picks its login (mirrors prepareShellConfigDirEnv).
const ACCOUNT_DIR_VAR: Partial<Record<TuiAgent, string>> = {
  omp: PRIMARY_AGENT_DIR_ENV_BY_KIND.omp,
  grok: 'GROK_HOME'
}
const TTL_MS = 10 * 60_000
const MAX_ENTRIES = 32

const cache = new Map<string, { result: DiscoverCommitMessageModelsResult; expiresAt: number }>()
// Share a probe for its whole timeout, not the dedupe's 30 s default.
const inFlight = new InFlightPromiseDedupe<DiscoverCommitMessageModelsResult>(
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS + 5_000
)
let generation = 0

onAgentsRefreshedOnHost(() => {
  generation += 1
  cache.clear()
  inFlight.clear()
})

export type ModelDiscoveryCacheInput = {
  agentId: TuiAgent
  agentCommandOverride: string | undefined
  env: NodeJS.ProcessEnv | undefined
  options: CommitMessageModelDiscoveryLocalOptions
}

/** Runs the probe; a probe-confirmed OMP or Grok list is reused for 10 min. */
export function discoverModelsWithHostCache(
  input: ModelDiscoveryCacheInput,
  probe: () => Promise<DiscoverCommitMessageModelsResult>
): Promise<DiscoverCommitMessageModelsResult> {
  const accountDirVar = ACCOUNT_DIR_VAR[input.agentId]
  if (!accountDirVar) {
    return probe()
  }
  const { cwd, wslDistro } = input.options
  // Not the whole env: the login-shell capture differs on every read (e.g. STARSHIP_SESSION_KEY).
  // Native probes ignore cwd, so only a WSL probe keys on it.
  const key = stableInFlightKey([
    input.agentId,
    input.agentCommandOverride ?? null,
    wslDistro ? { cwd: cwd ?? '', wslDistro } : null,
    input.env?.[accountDirVar] ?? null
  ])
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.result)
  }
  return inFlight.run(key, async () => {
    const startedIn = generation
    const result = await probe()
    // A refresh during the probe makes its answer stale.
    if (result.success && result.catalogOrigin === 'probe' && startedIn === generation) {
      setBoundedScopeCacheEntry(cache, key, { result, expiresAt: Date.now() + TTL_MS }, MAX_ENTRIES)
    }
    return result
  })
}
