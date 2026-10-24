import { ghExecFileWithScopeAsync } from './git/runner'

// Use ambient gh auth to avoid the shared per-IP quota; missing login falls back to unauthenticated.

const TOKEN_RESOLVE_TIMEOUT_MS = 5_000
// Cache misses too: spawning gh/WSL repeatedly is expensive when no token can be found.
const TOKEN_TTL_MS = 5 * 60_000

export type ReleaseApiToken = { token: string; rateLimitScope: string }
type TokenCacheEntry = { token: ReleaseApiToken | null; expiresAt: number }

let cached: TokenCacheEntry | null = null
let inFlight: Promise<ReleaseApiToken | null> | null = null
let generation = 0

async function readGhToken(): Promise<ReleaseApiToken | null> {
  try {
    // Do not retry a hung keyring; unauthenticated requests are an acceptable fallback.
    const { stdout, rateLimitScope } = await ghExecFileWithScopeAsync(
      ['auth', 'token', '--hostname', 'github.com'],
      {
        timeout: TOKEN_RESOLVE_TIMEOUT_MS,
        idempotent: false
      }
    )
    const token = stdout.replace(/\r?\n/g, '').trim()
    return token ? { token, rateLimitScope } : null
  } catch {
    return null
  }
}

export async function resolveReleaseApiToken(
  now: number = Date.now()
): Promise<ReleaseApiToken | null> {
  if (cached && cached.expiresAt > now) {
    return cached.token
  }
  if (inFlight) {
    return inFlight
  }
  const readGeneration = generation
  inFlight = readGhToken()
    .then((token) => {
      // A rejection during this read must not resurrect the refused keyring token.
      if (generation !== readGeneration) {
        return null
      }
      cached = { token, expiresAt: now + TOKEN_TTL_MS }
      return token
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Cache rejection for a TTL rather than re-reading a stale keyring token on every load. */
export function rejectReleaseApiToken(now: number = Date.now()): void {
  generation += 1
  cached = { token: null, expiresAt: now + TOKEN_TTL_MS }
}

/** @internal — test-only */
export function _resetReleaseApiTokenCache(): void {
  generation += 1
  cached = null
  inFlight = null
}
