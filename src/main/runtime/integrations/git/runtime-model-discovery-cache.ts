import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  InFlightPromiseDedupe,
  stableInFlightKey
} from '../../../../shared/in-flight-promise-dedupe'
import { setBoundedScopeCacheEntry } from '../../../../shared/native-chat/native-chat-scope-cache'
import { PRIMARY_AGENT_DIR_ENV_BY_KIND } from '../../../../shared/pi-agent-kind'
import { onAgentsRefreshedOnHost } from '../../../preflight/workspace-agent-detection'
import { discoverCommitMessageModelsLocal } from '../../../text-generation/commit-message-text-generation'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from '../../../text-generation/source-control-generation-limits'
import type { DiscoverCommitMessageModelsResult } from '../../../text-generation/source-control-text-generation-types'

// Phones list these on every chat open; other agents' lists have their own catalog owners.
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

// An agent refresh is how a user says the CLI or its login changed.
onAgentsRefreshedOnHost(() => {
  generation += 1
  cache.clear()
  inFlight.clear()
})

export type ModelDiscoveryInput = {
  agentId: TuiAgent
  agentCommandOverride: string | undefined
  env: NodeJS.ProcessEnv | undefined
  wsl: { cwd: string; wslDistro: string } | null
}

/** Probes the agent CLI; a probe-confirmed OMP or Grok list is reused for 10 min. */
export function discoverModelsWithHostCache(
  input: ModelDiscoveryInput
): Promise<DiscoverCommitMessageModelsResult> {
  const probe = (): Promise<DiscoverCommitMessageModelsResult> =>
    discoverCommitMessageModelsLocal(
      input.agentId,
      input.env,
      input.agentCommandOverride,
      input.wsl ?? undefined
    )
  const accountDirVar = ACCOUNT_DIR_VAR[input.agentId]
  if (!accountDirVar) {
    return probe()
  }
  // Not the whole env: the login-shell capture differs on every read (e.g. STARSHIP_SESSION_KEY).
  const key = stableInFlightKey([
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
    const result = await probe()
    // A refresh during the probe makes its answer stale.
    if (result.success && result.catalogOrigin === 'probe' && startedIn === generation) {
      setBoundedScopeCacheEntry(cache, key, { result, expiresAt: Date.now() + TTL_MS }, MAX_ENTRIES)
    }
    return result
  })
}
