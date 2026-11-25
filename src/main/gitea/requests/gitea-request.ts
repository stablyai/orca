import { getServerForHost, normalizeGiteaApiBaseUrl } from '../servers/gitea-server-store'
import type { GiteaRepoRef } from '../repository-ref'
import { giteaApiBelongsToRepoHost, validateGiteaApiUrl } from './gitea-api-url'
import { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'

// Shared Gitea REST plumbing used by both the pull-request client and the
// issue/task-source operations: resolves the API base + token for a repo
// (env vars first for back-compat, then a stored server matching the repo
// remote host) and issues authenticated reads and writes.

const DEFAULT_TIMEOUT_MS = 8000

export type GiteaResolvedAuth = {
  apiBaseUrl: string
  token: string | null
}

export type GiteaSearchParams = Record<string, string | number>

export type GiteaReadOptions = {
  searchParams?: GiteaSearchParams
  timeoutMs?: number
  token?: string | null
  // Only a single-resource read may treat 404 as "absent" when failures throw.
  allowNotFound?: boolean
}

export type GiteaWriteResult<T> =
  | { ok: true; data: T | null }
  | { ok: false; error: string; status: number | null }

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function getEnvGiteaAuth(): { apiBaseUrl: string | null; token: string | null } {
  const apiBaseUrl = envValue('ORCA_GITEA_API_BASE_URL')
  return {
    apiBaseUrl: apiBaseUrl ? normalizeGiteaApiBaseUrl(apiBaseUrl) : null,
    token: envValue('ORCA_GITEA_TOKEN')
  }
}

export async function resolveGiteaAuth(repo: GiteaRepoRef): Promise<GiteaResolvedAuth> {
  const env = getEnvGiteaAuth()
  if (env.token) {
    // With an explicit ORCA_GITEA_API_BASE_URL, scope the token to that host so a
    // global token can't leak to a different server. Without one, fall back to the
    // repo's own host — the documented env-var back-compat that hosted review uses.
    if (env.apiBaseUrl) {
      if (giteaApiBelongsToRepoHost(env.apiBaseUrl, repo.host)) {
        return { apiBaseUrl: env.apiBaseUrl, token: env.token }
      }
    } else {
      return { apiBaseUrl: repo.apiBaseUrl, token: env.token }
    }
  }
  const stored = await getServerForHost(repo.host)
  if (stored) {
    return { apiBaseUrl: stored.server.apiBaseUrl, token: stored.token }
  }
  // Anonymous reads still honor ORCA_GITEA_API_BASE_URL for its own host, like the hosted-review client did.
  const envBaseForRepo =
    env.apiBaseUrl && giteaApiBelongsToRepoHost(env.apiBaseUrl, repo.host) ? env.apiBaseUrl : null
  return { apiBaseUrl: envBaseForRepo ?? repo.apiBaseUrl, token: null }
}

// A token never follows a redirect; anonymous reads keep following them like before.
function redirectPolicy(token: string | null): RequestRedirect {
  return token ? 'error' : 'follow'
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `token ${token}` } : {}
}

export function giteaApiUrl(baseUrl: string, path: string, searchParams?: GiteaSearchParams): URL {
  const url = new URL(`${validateGiteaApiUrl(baseUrl)}${path}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

export function encodedRepoPath(repo: Pick<GiteaRepoRef, 'owner' | 'repo'>): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}

// Low-level authenticated GET against an explicit API base. Returns null on any
// non-2xx response or transport error (callers treat null as "unavailable").
// Why: the existing-review lookup behind Create must tell a real transport/auth
// failure apart from an accepted "no PR", so it opts into throwing instead.
export async function giteaGetJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: GiteaReadOptions = {},
  throwOnFailure = false
): Promise<T | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(giteaApiUrl(baseUrl, path, options.searchParams), {
      headers: { Accept: 'application/json', ...authHeaders(options.token ?? null) },
      redirect: redirectPolicy(options.token ?? null),
      signal: controller.signal
    })
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      if (throwOnFailure && !(options.allowNotFound && response.status === 404)) {
        throw new Error(`Gitea request failed: HTTP ${response.status}`)
      }
      return null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The caller names this Gitea endpoint's wire shape; domain mappers validate identifiers before exposing records.
    return (await response.json()) as T
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// Repo-scoped authenticated GET; resolves auth from the repo remote host.
export async function giteaRepoGet<T>(
  repo: GiteaRepoRef,
  path: string,
  options: Omit<GiteaReadOptions, 'token'> = {},
  throwOnFailure = false
): Promise<T | null> {
  const auth = await resolveGiteaAuth(repo)
  return giteaGetJsonAtBase<T>(
    auth.apiBaseUrl,
    path,
    { ...options, token: auth.token },
    throwOnFailure
  )
}

// Repo-scoped authenticated GET that returns the raw response text (e.g. the
// raw file content endpoint used to build PR diffs). Returns null on non-2xx.
export async function giteaRepoGetText(
  repo: GiteaRepoRef,
  path: string,
  options: Omit<GiteaReadOptions, 'token'> = {}
): Promise<string | null> {
  const auth = await resolveGiteaAuth(repo)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(giteaApiUrl(auth.apiBaseUrl, path, options.searchParams), {
      headers: authHeaders(auth.token),
      redirect: redirectPolicy(auth.token),
      signal: controller.signal
    })
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      return null
    }
    return await response.text()
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function readGiteaError(response: Response): Promise<string> {
  try {
    const data = z
      .object({ message: z.string().optional(), errors: z.array(z.string()).optional() })
      .parse(await response.json())
    const messages = [...(data.message ? [data.message] : []), ...(data.errors ?? [])].filter(
      Boolean
    )
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    await cancelUnreadResponseBody(response)
  }
  return response.statusText || `Gitea request failed (${response.status})`
}

// Repo-scoped authenticated write (POST/PATCH/DELETE) returning a discriminated
// result so callers can surface server error messages.
export async function giteaRepoWrite<T>(
  repo: GiteaRepoRef,
  path: string,
  init: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; timeoutMs?: number }
): Promise<GiteaWriteResult<T>> {
  const auth = await resolveGiteaAuth(repo)
  if (!auth.token) {
    return { ok: false, error: 'Connect a Gitea account to make changes.', status: null }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(giteaApiUrl(auth.apiBaseUrl, path), {
      method: init.method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...authHeaders(auth.token)
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) {
      return { ok: false, error: await readGiteaError(response), status: response.status }
    }
    // Some mutations (merge) answer 200 with an empty body, which is still a success.
    const text = response.status === 204 ? '' : await response.text()
    if (!text.trim()) {
      return { ok: true, data: null }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The caller names the mutation endpoint's wire shape and checks required identifiers before using the response.
    return { ok: true, data: JSON.parse(text) as T }
  } catch {
    return { ok: false, error: 'Could not reach the Gitea server.', status: null }
  } finally {
    clearTimeout(timeout)
  }
}
