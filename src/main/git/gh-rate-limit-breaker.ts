/**
 * Global circuit breaker for gh CLI primary rate limits.
 *
 * Why: a primary rate-limit 403 means every further request in that bucket
 * will fail until GitHub's reset time. Without shared state, a 90-repo
 * Tasks-page fan-out keeps spawning gh subprocesses that each take a fresh
 * 403 — burning main-thread spawn time and log noise while returning nothing
 * (the Discord "countWorkItems failed ×90" storm). This module holds
 * blocked-until state consulted by the runner before every gh spawn.
 *
 * Lives under git/ (not github/) with zero imports so both the runner and
 * the github rate-limit prober can use it without an import cycle.
 */

export type GhRateLimitBucket = 'core' | 'search' | 'graphql'

// Why: a primary 403 does not carry the reset time. The search window resets
// every minute; core/graphql reset hourly but blocking a full hour on a guess
// would be too punishing, so pick a modest re-probe interval. The registered
// reset probe (gh api rate_limit — exempt from limits) refines these to the
// real reset time right after the breaker trips.
const FALLBACK_BLOCK_MS: Record<GhRateLimitBucket, number> = {
  search: 70_000,
  core: 5 * 60_000,
  graphql: 5 * 60_000
}

// Why: the runner derives scopes with this builder too — a format drift would
// silently split blocks from the default-scope reads below.
export function ghRateLimitScopeKey(runtime: string, host: string): string {
  return `${runtime}:${host.toLowerCase()}`
}

export type GhRateLimitScopeParts =
  | { runtime: 'native'; host: string }
  | { runtime: 'wsl'; wslDistro: string; host: string }

// Why: the reset probe must spawn gh against the tripping scope's runtime and
// host. Parsing lives next to the builder so the key format stays private to
// this module instead of being string-split at call sites.
export function parseGhRateLimitScopeKey(scope: string): GhRateLimitScopeParts | null {
  if (scope.startsWith('native:')) {
    const host = scope.slice('native:'.length)
    return host ? { runtime: 'native', host } : null
  }
  if (scope.startsWith('wsl:')) {
    // Hosts may carry a port (host:port), so only the first colon after the
    // distro is a separator.
    const rest = scope.slice('wsl:'.length)
    const sep = rest.indexOf(':')
    if (sep <= 0 || sep === rest.length - 1) {
      return null
    }
    return { runtime: 'wsl', wslDistro: rest.slice(0, sep), host: rest.slice(sep + 1) }
  }
  return null
}

const DEFAULT_SCOPE = ghRateLimitScopeKey('native', 'github.com')
const GH_RATE_LIMIT_BLOCK_MAX_ENTRIES = 1024
const blockedUntilMsByScopeAndBucket = new Map<string, number>()
let resetProbe: ((bucket: GhRateLimitBucket, scope: string) => void) | null = null

function breakerKey(bucket: GhRateLimitBucket, scope = DEFAULT_SCOPE): string {
  return `${scope}\0${bucket}`
}

// gh api flags that take a separate value, so the endpoint arg can be found.
const GH_API_VALUE_FLAGS = new Set([
  '--cache',
  '--jq',
  '-q',
  '--method',
  '-X',
  '--field',
  '-F',
  '--raw-field',
  '-f',
  '--header',
  '-H',
  '--hostname',
  '--input',
  '--template',
  '-t',
  '--preview',
  '-p'
])

function findGhApiEndpoint(args: readonly string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-')) {
      return arg
    }
    if (GH_API_VALUE_FLAGS.has(arg)) {
      i++
    }
  }
  return null
}

export function classifyGhRateLimitBucket(args: readonly string[]): GhRateLimitBucket {
  const command = args[0]
  if (command === 'search') {
    return 'search'
  }
  if (command !== 'api') {
    return 'core'
  }
  const endpoint = findGhApiEndpoint(args)
  if (!endpoint) {
    return 'core'
  }
  const path = endpoint.replace(/^\//, '')
  if (path.startsWith('search/')) {
    return 'search'
  }
  if (path === 'graphql' || path.startsWith('graphql?')) {
    return 'graphql'
  }
  return 'core'
}

/** `gh api rate_limit` is exempt from rate limits and must never be blocked —
 * it is the probe that refines the breaker's reset time. */
export function isGhRateLimitProbe(args: readonly string[]): boolean {
  if (args[0] !== 'api') {
    return false
  }
  const endpoint = findGhApiEndpoint(args)
  return endpoint === 'rate_limit' || endpoint === '/rate_limit'
}

/**
 * Primary rate-limit detection. Secondary limits ("secondary rate limit")
 * carry Retry-After and are handled by the runner's transient retry logic.
 */
export function isGhPrimaryRateLimitStderr(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return s.includes('api rate limit exceeded') && !s.includes('secondary rate limit')
}

export function recordGhPrimaryRateLimit(
  bucket: GhRateLimitBucket,
  blockedUntilMs: number,
  scope = DEFAULT_SCOPE
): void {
  const key = breakerKey(bucket, scope)
  const existing = blockedUntilMsByScopeAndBucket.get(key) ?? 0
  // Why: host scopes can originate from pasted GHES URLs. Refresh insertion
  // order and cap retained blocks so a stream of failing hosts cannot grow the
  // main-process map for the lifetime of the app.
  blockedUntilMsByScopeAndBucket.delete(key)
  blockedUntilMsByScopeAndBucket.set(key, Math.max(existing, blockedUntilMs))
  while (blockedUntilMsByScopeAndBucket.size > GH_RATE_LIMIT_BLOCK_MAX_ENTRIES) {
    const oldestKey = blockedUntilMsByScopeAndBucket.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    blockedUntilMsByScopeAndBucket.delete(oldestKey)
  }
}

export function clearGhRateLimitBlock(bucket: GhRateLimitBucket, scope = DEFAULT_SCOPE): void {
  blockedUntilMsByScopeAndBucket.delete(breakerKey(bucket, scope))
}

export function getGhRateLimitBlockedUntilMs(
  bucket: GhRateLimitBucket,
  nowMs: number = Date.now(),
  scope = DEFAULT_SCOPE
): number | null {
  for (const [key, blockedUntil] of blockedUntilMsByScopeAndBucket) {
    if (blockedUntil <= nowMs) {
      blockedUntilMsByScopeAndBucket.delete(key)
    }
  }
  const key = breakerKey(bucket, scope)
  const blockedUntil = blockedUntilMsByScopeAndBucket.get(key)
  if (blockedUntil === undefined) {
    return null
  }
  if (blockedUntil <= nowMs) {
    blockedUntilMsByScopeAndBucket.delete(key)
    return null
  }
  // Why: active blocks are hot entries; refresh their insertion order so a
  // stream of one-off hostile hosts evicts cold scopes before an active one.
  blockedUntilMsByScopeAndBucket.delete(key)
  blockedUntilMsByScopeAndBucket.set(key, blockedUntil)
  return blockedUntil
}

/** @internal — cache-bound tests only. */
export function _getGhRateLimitBlockCount(): number {
  return blockedUntilMsByScopeAndBucket.size
}

/** Register the (single) callback that refreshes precise reset times after a
 * breaker trip. Registered by the github rate-limit prober at module load. */
export function registerGhRateLimitResetProbe(
  probe: ((bucket: GhRateLimitBucket, scope: string) => void) | null
): void {
  resetProbe = probe
}

/** Called by the runner when a gh spawn came back with a primary 403. */
export function notifyGhPrimaryRateLimit(bucket: GhRateLimitBucket, scope = DEFAULT_SCOPE): void {
  recordGhPrimaryRateLimit(bucket, Date.now() + FALLBACK_BLOCK_MS[bucket], scope)
  // The probe receives the tripping scope so it can run gh against that
  // runtime/host and refine the fallback block into the real reset time.
  try {
    resetProbe?.(bucket, scope)
  } catch {
    // best-effort refinement; the fallback block stands
  }
}

export function createGhRateLimitBlockedError(
  bucket: GhRateLimitBucket,
  blockedUntilMs: number
): Error & { stderr: string; ghRateLimitBlocked: true } {
  const resetsIn = Math.max(1, Math.ceil((blockedUntilMs - Date.now()) / 1000))
  // Why: "rate limit" (and no "HTTP 403") so classifyGhError maps this to
  // rate_limited instead of permission_denied, matching a real gh failure.
  const message = `GitHub API rate limit exceeded (${bucket}); retrying in ~${resetsIn}s without spawning gh.`
  return Object.assign(new Error(message), {
    stderr: message,
    ghRateLimitBlocked: true as const
  })
}

/** @internal — test-only */
export function _resetGhRateLimitBreaker(): void {
  blockedUntilMsByScopeAndBucket.clear()
  resetProbe = null
}
