// A person's own OAuth login kept on this host (Linear's, Google's) stays usable without Orca Cloud:
// refreshed here when due or refused, one refresh per login at a time, and handed back to its owner
// to save, or to forget when the provider says the grant is gone.
import { z } from 'zod'

const REFRESH_TIMEOUT_MS = 15_000

export type HostOAuthRefreshDeps = { now: () => number; request: typeof fetch }
export const defaultHostOAuthRefreshDeps: HostOAuthRefreshDeps = {
  now: Date.now,
  request: (input, init) => fetch(input, init)
}

/** What a refresh needs from a saved login. `clientSecret` only for providers that require it. */
export type HostOAuthGrant = {
  refreshToken: string
  expiresAt: number
  clientId: string
  clientSecret?: string
}

export type HostOAuthRefreshed = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  /** Space-separated scopes, when the provider says. */
  scope?: string
}

/**
 * fresh: not due; refreshed: saved; offline: try again later; ended: the grant is gone;
 * superseded: the login was removed or replaced while the refresh ran, so nothing was written.
 */
export type HostOAuthRefreshOutcome =
  | 'none'
  | 'fresh'
  | 'refreshed'
  | 'offline'
  | 'ended'
  | 'superseded'

export type HostOAuthRefresherConfig<TLogin> = {
  tokenUrl: string
  refreshAheadMs: number
  /** Errors that mean the grant is gone for good (always includes `invalid_grant`). */
  endedErrors?: readonly string[]
  /** A provider that rotates refresh tokens must return one; else the old one is kept. */
  rotates: boolean
  read: (id: string) => TLogin | null | Promise<TLogin | null>
  /** Null when the login has nothing to refresh with. */
  grantOf: (login: TLogin) => HostOAuthGrant | null
  /** Gets the login as saved now, never the one read before the request. */
  save: (id: string, login: TLogin, refreshed: HostOAuthRefreshed) => void | Promise<void>
  ended: (id: string, login: TLogin, error: string) => void | Promise<void>
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().min(1).optional()
})
const ErrorResponse = z.object({ error: z.string().min(1) })

export type HostOAuthRefresher = {
  /** Refreshes when due, or now when the provider refused the token (force). */
  refresh: (
    id: string,
    deps?: HostOAuthRefreshDeps,
    force?: boolean
  ) => Promise<HostOAuthRefreshOutcome>
  isDue: (grant: Pick<HostOAuthGrant, 'expiresAt'>, now: number) => boolean
}

export function createHostOAuthRefresher<TLogin>(
  config: HostOAuthRefresherConfig<TLogin>
): HostOAuthRefresher {
  const running = new Map<string, Promise<HostOAuthRefreshOutcome>>()
  const ended = new Set(['invalid_grant', ...(config.endedErrors ?? [])])
  const isDue = (grant: Pick<HostOAuthGrant, 'expiresAt'>, now: number) =>
    grant.expiresAt - now <= config.refreshAheadMs

  async function refreshOnce(
    id: string,
    deps: HostOAuthRefreshDeps,
    force: boolean
  ): Promise<HostOAuthRefreshOutcome> {
    const login = await config.read(id)
    const grant = login ? config.grantOf(login) : null
    if (!login || !grant) {
      return 'none'
    }
    if (!force && !isDue(grant, deps.now())) {
      return 'fresh'
    }
    let response: Response
    try {
      response = await deps.request(config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: grant.refreshToken,
          client_id: grant.clientId,
          ...(grant.clientSecret ? { client_secret: grant.clientSecret } : {})
        }).toString(),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
      })
    } catch {
      return 'offline'
    }
    const body: unknown = await response.json().catch(() => null)
    // A disconnect or a new sign-in during the request wins: only the grant this refresh used is written.
    const current = await config.read(id)
    if (!current || config.grantOf(current)?.refreshToken !== grant.refreshToken) {
      return 'superseded'
    }
    if (response.ok) {
      const tokens = TokenResponse.safeParse(body).data
      const refreshToken =
        tokens?.refresh_token ?? (config.rotates ? undefined : grant.refreshToken)
      if (!tokens || !refreshToken) {
        return 'offline'
      }
      await config.save(id, current, {
        accessToken: tokens.access_token,
        refreshToken,
        expiresAt: deps.now() + tokens.expires_in * 1000,
        ...(tokens.scope ? { scope: tokens.scope } : {})
      })
      return 'refreshed'
    }
    const error = ErrorResponse.safeParse(body).data?.error
    // invalid_grant arrives as a 400; a deleted client (invalid_client) can come as a 401.
    const gone =
      error !== undefined &&
      ((response.status === 400 && ended.has(error)) ||
        (response.status === 401 && (config.endedErrors ?? []).includes(error)))
    if (gone) {
      await config.ended(id, current, error)
      return 'ended'
    }
    return 'offline'
  }

  return {
    isDue,
    refresh: (id, deps = defaultHostOAuthRefreshDeps, force = false) => {
      let refresh = running.get(id)
      if (!refresh) {
        refresh = refreshOnce(id, deps, force).finally(() => running.delete(id))
        running.set(id, refresh)
      }
      return refresh
    }
  }
}
