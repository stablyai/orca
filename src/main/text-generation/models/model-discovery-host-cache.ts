import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { InFlightPromiseDedupe, stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import { setBoundedScopeCacheEntry } from '../../../shared/native-chat/native-chat-scope-cache'
import { PRIMARY_AGENT_DIR_ENV_BY_KIND } from '../../../shared/pi-agent-kind'
import { onAgentsRefreshedOnHost } from '../../preflight/agents-refreshed-on-host'
import type { CommitMessageModelDiscoveryLocalOptions } from './commit-message-model-discovery'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from '../execution/source-control-generation-limits'
import type { DiscoverCommitMessageModelsResult } from '../source-control-text-generation-types'

// Pickers list these on open; Codex's listing starts an app-server. Each maps to the config-dir var
// that picks its login (mirrors prepareShellConfigDirEnv).
const ACCOUNT_DIR_VAR: Partial<Record<TuiAgent, string>> = {
  omp: PRIMARY_AGENT_DIR_ENV_BY_KIND.omp,
  grok: 'GROK_HOME',
  codex: 'CODEX_HOME',
  cursor: 'CURSOR_CONFIG_DIR'
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

// Windows environment names ignore case; like Node's spawn, the lexicographically first spelling wins.
function accountDir(env: NodeJS.ProcessEnv | undefined, name: string): string | null {
  const key =
    process.platform === 'win32'
      ? Object.keys(env ?? {})
          .filter((entry) => entry.toUpperCase() === name)
          .sort()[0]
      : name
  return (key && env?.[key]) ?? null
}

export type ModelDiscoveryCacheInput = {
  agentId: TuiAgent
  agentCommandOverride: string | undefined
  env: NodeJS.ProcessEnv | undefined
  options: CommitMessageModelDiscoveryLocalOptions
}

/** Runs the probe; a probe-confirmed OMP, Grok, Codex or Cursor list is reused for 10 min. */
export function discoverModelsWithHostCache(
  input: ModelDiscoveryCacheInput,
  probe: () => Promise<DiscoverCommitMessageModelsResult>
): Promise<DiscoverCommitMessageModelsResult> {
  const accountDirVar = ACCOUNT_DIR_VAR[input.agentId]
  if (
    (!accountDirVar && input.agentId !== 'antigravity') ||
    (input.options.uncached && input.agentId !== 'antigravity')
  ) {
    return probe()
  }
  const key = modelDiscoveryHostCacheKey(input)
  const cached = cache.get(key)
  if (input.agentId !== 'antigravity' && cached && cached.expiresAt > Date.now()) {
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

function modelDiscoveryHostCacheKey(input: ModelDiscoveryCacheInput): string {
  const { cwd, wslDistro, agentEnv, useCwdForNative } = input.options
  const env = input.env ?? (wslDistro ? undefined : process.env)
  return stableInFlightKey([
    input.agentId,
    input.agentCommandOverride ?? null,
    wslDistro ? { cwd: cwd ?? '', wslDistro } : useCwdForNative ? { cwd: cwd ?? '' } : null,
    input.agentId === 'antigravity'
      ? {
          home: accountDir(env, 'HOME'),
          userProfile: accountDir(env, 'USERPROFILE'),
          configHome: accountDir(env, 'XDG_CONFIG_HOME'),
          agentEnv: Object.entries(agentEnv ?? {}).sort(([a], [b]) => a.localeCompare(b))
        }
      : accountDir(env, ACCOUNT_DIR_VAR[input.agentId] ?? '')
  ])
}

/** A launch may use stale inventory, but must never start or await discovery. */
export function peekAntigravityModels(input: ModelDiscoveryCacheInput) {
  const result = cache.get(modelDiscoveryHostCacheKey(input))?.result
  return result?.success && result.catalogOrigin === 'probe' ? result.models : undefined
}
