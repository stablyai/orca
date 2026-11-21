import { createHash } from 'node:crypto'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  InFlightPromiseDedupe,
  stableInFlightKey
} from '../../../shared/concurrency/in-flight-promise-dedupe'
import { setBoundedScopeCacheEntry } from '../../../shared/native-chat/input/composer/native-chat-scope-cache'
import { PRIMARY_AGENT_DIR_ENV_BY_KIND } from '../../../shared/agent-launch/catalog/pi-agent-kind'
import { CLAUDE_AUTH_ENV_VARS } from '../../claude-accounts/runtime-auth/environment'
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
  cursor: 'CURSOR_CONFIG_DIR',
  claude: 'CLAUDE_CONFIG_DIR'
}
// Same config dir can still list different models when routing or auth changes.
const CLAUDE_ROUTING_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CONFIG_DIR'
] as const
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
function readEnv(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  const key =
    process.platform === 'win32'
      ? Object.keys(env ?? {})
          .filter((entry) => entry.toUpperCase() === name)
          .sort()[0]
      : name
  if (!key || !Object.hasOwn(env ?? {}, key)) {
    return undefined
  }
  const value = env?.[key]
  return typeof value === 'string' ? value : undefined
}

function tokenFingerprint(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null
  }
  return createHash('sha256').update(value).digest('hex')
}

/** Every defined override, including `""`, so an explicit empty value misses a key that omits it. */
function overrideFingerprint(envs: readonly (NodeJS.ProcessEnv | undefined)[]): string | null {
  const merged = new Map<string, string>()
  for (const env of envs) {
    for (const [key, value] of Object.entries(env ?? {})) {
      if (typeof value === 'string') {
        merged.set(key, value)
      }
    }
  }
  if (merged.size === 0) {
    return null
  }
  const entries = [...merged.entries()].sort(([left], [right]) => left.localeCompare(right))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

function claudeModelEnvScope(env: NodeJS.ProcessEnv | undefined): unknown {
  return [
    CLAUDE_ROUTING_ENV.map((name) => tokenFingerprint(readEnv(env, name))),
    CLAUDE_AUTH_ENV_VARS.map((name) => tokenFingerprint(readEnv(env, name))),
    // Login-shell headers are not in launchEnv/accountPatch. `""` hashes; a missing key stays null.
    tokenFingerprint(readEnv(env, 'ANTHROPIC_CUSTOM_HEADERS'))
  ]
}

export type ModelDiscoveryCacheInput = {
  agentId: TuiAgent
  agentCommandOverride: string | undefined
  env: NodeJS.ProcessEnv | undefined
  options: CommitMessageModelDiscoveryLocalOptions
  /** SSH target. Local and WSL probes leave this unset. */
  connectionId?: string
  /** Terminal launch env. Hashed into the key; absent when the launch exports nothing. */
  launchEnv?: NodeJS.ProcessEnv
  /** Account patch. Hashed with the launch env; explicit `""` differs from an omitted key. */
  accountPatch?: NodeJS.ProcessEnv
}

export function modelDiscoveryHostCacheKey(input: ModelDiscoveryCacheInput): string | null {
  const accountDirVar = ACCOUNT_DIR_VAR[input.agentId]
  if (!accountDirVar) {
    return null
  }
  const { cwd, wslDistro } = input.options
  const connectionId = input.connectionId ?? null
  // Not the whole env: the login-shell capture differs on every read (e.g. STARSHIP_SESSION_KEY).
  // Native probes ignore cwd, so only a WSL or SSH probe keys on it.
  // A native probe without an env spawns with process.env. WSL and SSH run with the guest's env.
  const envForKey = input.env ?? (wslDistro || connectionId ? undefined : process.env)
  return stableInFlightKey([
    input.agentId,
    tokenFingerprint(input.agentCommandOverride ?? null),
    connectionId,
    wslDistro || connectionId
      ? { cwd: tokenFingerprint(cwd ?? ''), wslDistro: wslDistro ?? null }
      : null,
    // Why: a native probe without an env spawns with process.env; a WSL guest's env isn't ours to read.
    // The directory is a user path, so only its hash may leave this function.
    tokenFingerprint(readEnv(envForKey, accountDirVar) ?? null),
    input.agentId === 'claude' ? claudeModelEnvScope(envForKey) : null,
    overrideFingerprint([input.launchEnv, input.accountPatch])
  ])
}

/** Runs the probe; a probe-confirmed Claude, OMP, Grok, Codex or Cursor list is reused for 10 min. */
export function discoverModelsWithHostCache(
  input: ModelDiscoveryCacheInput,
  probe: () => Promise<DiscoverCommitMessageModelsResult>
): Promise<DiscoverCommitMessageModelsResult> {
  const key = modelDiscoveryHostCacheKey(input)
  if (!key) {
    return probe()
  }
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
