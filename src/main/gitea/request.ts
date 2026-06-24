/* Shared REST transport for all Gitea/Forgejo operations — extracted from
   client.ts so PR + issue code share identical auth without re-implementing
   fetch/timeout/auth-header inline. Single source of truth. */
import type { GiteaRepoRef } from './repository-ref'

const REQUEST_TIMEOUT_MS = 5000

export type GiteaAuthConfig = {
  apiBaseUrl: string | null
  token: string | null
}

export type RequestOptions = {
  searchParams?: Record<string, string | number>
  timeoutMs?: number
  method?: string
  body?: unknown
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function normalizeGiteaApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

export function getAuthConfig(): GiteaAuthConfig {
  const apiBaseUrl = envValue('ORCA_GITEA_API_BASE_URL')
  return {
    apiBaseUrl: apiBaseUrl ? normalizeGiteaApiBaseUrl(apiBaseUrl) : null,
    token: envValue('ORCA_GITEA_TOKEN')
  }
}

export function authHeaders(config: Pick<GiteaAuthConfig, 'token'>): Record<string, string> {
  // Why: Gitea convention is "Authorization: token <token>" — NOT Bearer.
  // Forgejo accepts the same header. Never use Bearer here.
  return config.token ? { Authorization: `token ${config.token}` } : {}
}

export function configuredApiBaseUrl(repo: GiteaRepoRef): string {
  return getAuthConfig().apiBaseUrl ?? repo.apiBaseUrl
}

function apiUrl(baseUrl: string, path: string, searchParams?: RequestOptions['searchParams']): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

export async function requestJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {}
): Promise<T | null> {
  const config = getAuthConfig()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const fetchOptions: RequestInit = {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(config),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      signal: controller.signal
    }
    if (options.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body)
    }
    const response = await fetch(apiUrl(baseUrl, path, options.searchParams), fetchOptions)
    if (!response.ok) {
      return null
    }
    // Why: some endpoints (e.g. DELETE) return 204 No Content — don't parse.
    if (response.status === 204) {
      return null
    }
    return (await response.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export function requestJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: RequestOptions = {}
): Promise<T | null> {
  return requestJsonAtBase(configuredApiBaseUrl(repo), path, options)
}

export function encodedRepoPath(repo: GiteaRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}
