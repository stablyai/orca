import { getServerForHost, normalizeGiteaApiBaseUrl } from './server-store'
import type { GiteaRepoRef } from './repository-ref'

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
}

export type GiteaWriteResult<T> =
  | { ok: true; data: T }
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

function sameHost(apiBaseUrl: string, repoHost: string): boolean {
  try {
    return new URL(apiBaseUrl).host.toLowerCase() === repoHost.toLowerCase()
  } catch {
    return false
  }
}

export function resolveGiteaAuth(repo: GiteaRepoRef): GiteaResolvedAuth {
  const env = getEnvGiteaAuth()
  if (env.token) {
    // With an explicit ORCA_GITEA_API_BASE_URL, scope the token to that host so a
    // global token can't leak to a different server. Without one, fall back to the
    // repo's own host — the documented env-var back-compat that hosted review uses.
    if (env.apiBaseUrl) {
      if (sameHost(env.apiBaseUrl, repo.host)) {
        return { apiBaseUrl: env.apiBaseUrl, token: env.token }
      }
    } else {
      return { apiBaseUrl: repo.apiBaseUrl, token: env.token }
    }
  }
  const stored = getServerForHost(repo.host)
  if (stored) {
    return { apiBaseUrl: stored.server.apiBaseUrl, token: stored.token }
  }
  return { apiBaseUrl: repo.apiBaseUrl, token: null }
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `token ${token}` } : {}
}

export function giteaApiUrl(baseUrl: string, path: string, searchParams?: GiteaSearchParams): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
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
export async function giteaGetJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: GiteaReadOptions = {}
): Promise<T | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(giteaApiUrl(baseUrl, path, options.searchParams), {
      headers: { Accept: 'application/json', ...authHeaders(options.token ?? null) },
      signal: controller.signal
    })
    if (!response.ok) {
      return null
    }
    return (await response.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// Repo-scoped authenticated GET; resolves auth from the repo remote host.
export function giteaRepoGet<T>(
  repo: GiteaRepoRef,
  path: string,
  options: Omit<GiteaReadOptions, 'token'> = {}
): Promise<T | null> {
  const auth = resolveGiteaAuth(repo)
  return giteaGetJsonAtBase<T>(auth.apiBaseUrl, path, { ...options, token: auth.token })
}

// Repo-scoped authenticated GET that returns the raw response text (e.g. the
// raw file content endpoint used to build PR diffs). Returns null on non-2xx.
export async function giteaRepoGetText(
  repo: GiteaRepoRef,
  path: string,
  options: Omit<GiteaReadOptions, 'token'> = {}
): Promise<string | null> {
  const auth = resolveGiteaAuth(repo)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(giteaApiUrl(auth.apiBaseUrl, path, options.searchParams), {
      headers: auth.token ? { Authorization: `token ${auth.token}` } : {},
      signal: controller.signal
    })
    if (!response.ok) {
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
    const data = (await response.json()) as { message?: string; errors?: string[] }
    const messages = [...(data.message ? [data.message] : []), ...(data.errors ?? [])].filter(
      Boolean
    )
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    // Fall through to status text.
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
  const auth = resolveGiteaAuth(repo)
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
      signal: controller.signal
    })
    if (!response.ok) {
      return { ok: false, error: await readGiteaError(response), status: response.status }
    }
    if (response.status === 204) {
      return { ok: true, data: null as T }
    }
    return { ok: true, data: (await response.json()) as T }
  } catch {
    return { ok: false, error: 'Could not reach the Gitea server.', status: null }
  } finally {
    clearTimeout(timeout)
  }
}
