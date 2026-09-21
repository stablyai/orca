import { ghExecFileWithScopeAsync } from './git/runner'

/**
 * The github.com token the release picker attaches to its api.github.com calls.
 *
 * Why: an unauthenticated request draws from a 60/hour bucket shared by every
 * caller behind the same public IP — Homebrew, other apps, agents running curl
 * — so the picker can find it empty without ever having spent it. The user's
 * own token has its own 5000/hour bucket. `gh auth token` is a local keyring
 * read that never touches the API; a missing or logged-out gh just means the
 * request goes out unauthenticated as before. The token is never logged.
 *
 * Why not resolveGhAccountToken: that resolves a per-project bound account and
 * needs a binding plus a `gh auth token --user` capability probe. This is the
 * ambient login, and "no token" is an ordinary outcome here, not an error.
 */

const TOKEN_RESOLVE_TIMEOUT_MS = 5_000
// Why one TTL for hits and misses: a miss re-spawns gh — through wsl.exe on a
// Windows box without a native gh — so a short miss TTL would make the picker
// slower for exactly the users who can never get a token.
const TOKEN_TTL_MS = 5 * 60_000

export type ReleaseApiToken = { token: string; rateLimitScope: string }
type TokenCacheEntry = { token: ReleaseApiToken | null; expiresAt: number }

let cached: TokenCacheEntry | null = null
let inFlight: Promise<ReleaseApiToken | null> | null = null
// Why: a rejection must beat a read that was already in flight when it landed.
let generation = 0

async function readGhToken(): Promise<ReleaseApiToken | null> {
  try {
    // Why no retry: a hung keyring would otherwise hold the picker through the
    // runner's backoff, and unauthenticated is an acceptable fallback anyway.
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
      // Why: a rejection during this read refused the same keyring entry this read
      // returns, so caching or handing it back would resurrect the rejected token.
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

/** GitHub rejected the token: go unauthenticated for a TTL instead of re-reading the same stale keyring entry on every load. */
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
