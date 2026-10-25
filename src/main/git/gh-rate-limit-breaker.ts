/** Share primary-limit blocks across gh calls; no imports to avoid runner/prober cycles. */

export type GhRateLimitBucket = 'core' | 'search' | 'graphql'

// Use short fallback blocks until the reset probe learns the true reset time.
const FALLBACK_BLOCK_MS: Record<GhRateLimitBucket, number> = {
  search: 70_000,
  core: 5 * 60_000,
  graphql: 5 * 60_000
}

export function ghRateLimitScopeKey(runtime: string, host: string): string {
  return `${runtime}:${host.toLowerCase()}`
}

export type GhRateLimitScopeParts =
  | { runtime: 'native'; host: string }
  | { runtime: 'wsl'; wslDistro: string; host: string }

// Parse beside the builder so reset probes use the blocked host/runtime without duplicating the format.
export function parseGhRateLimitScopeKey(scope: string): GhRateLimitScopeParts | null {
  if (scope.startsWith('native:')) {
    const host = scope.slice('native:'.length)
    return host ? { runtime: 'native', host } : null
  }
  if (scope.startsWith('wsl:')) {
    // Split only after the distro; host values may contain a port.
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

/** Never block rate_limit: it refines the breaker's reset time. */
export function isGhRateLimitProbe(args: readonly string[]): boolean {
  if (args[0] !== 'api') {
    return false
  }
  const endpoint = findGhApiEndpoint(args)
  return endpoint === 'rate_limit' || endpoint === '/rate_limit'
}

/** `gh auth token …` is a local keyring read that never reaches the API, so a tripped breaker must not gate it. */
export function isGhLocalOnlyCommand(args: readonly string[]): boolean {
  return args[0] === 'auth' && args[1] === 'token'
}

/** Recognize primary limits; secondary limits use Retry-After handling. */
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
  // Bound pasted-host state and refresh insertion order so one-off failures cannot grow the map forever.
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
  // Refresh active scopes so one-off hosts evict colder blocks first.
  blockedUntilMsByScopeAndBucket.delete(key)
  blockedUntilMsByScopeAndBucket.set(key, blockedUntil)
  return blockedUntil
}

/** @internal — cache-bound tests only. */
export function _getGhRateLimitBlockCount(): number {
  return blockedUntilMsByScopeAndBucket.size
}

/** Register the GitHub prober's callback to refine reset times after a breaker trip. */
export function registerGhRateLimitResetProbe(
  probe: ((bucket: GhRateLimitBucket, scope: string) => void) | null
): void {
  resetProbe = probe
}

export function notifyGhPrimaryRateLimit(bucket: GhRateLimitBucket, scope = DEFAULT_SCOPE): void {
  recordGhPrimaryRateLimit(bucket, Date.now() + FALLBACK_BLOCK_MS[bucket], scope)
  try {
    resetProbe?.(bucket, scope)
  } catch {}
}

export function createGhRateLimitBlockedError(
  bucket: GhRateLimitBucket,
  blockedUntilMs: number
): Error & { stderr: string; ghRateLimitBlocked: true } {
  const resetsIn = Math.max(1, Math.ceil((blockedUntilMs - Date.now()) / 1000))
  // Match classifyGhError's rate_limited classification rather than HTTP 403 permission_denied.
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
