import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { gtRepoArgs, type GiteaRepoRef } from './repository-ref'
import { gtApiWithHeaders } from './gt-api-response'

export function normalizeGiteaApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

const REQUEST_TIMEOUT_MS = 10_000

export type GiteaJsonRequestOptions = {
  searchParams?: Record<string, string | number>
  timeoutMs?: number
  allowNotFound?: boolean
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function configuredGiteaApiBaseUrl(repo: GiteaRepoRef): string {
  const override = envValue('ORCA_GITEA_API_BASE_URL')
  return override ? normalizeGiteaApiBaseUrl(override) : repo.apiBaseUrl
}

function directApiToken(): string | null {
  return envValue('ORCA_GITEA_TOKEN') ?? envValue('GITEA_TOKEN')
}

function prefersGtApi(repo: GiteaRepoRef): boolean {
  return directApiToken() === null && Boolean(repo.loginName)
}

function apiUrl(
  baseUrl: string,
  path: string,
  searchParams?: GiteaJsonRequestOptions['searchParams']
): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

function gtRequestPath(
  path: string,
  searchParams?: GiteaJsonRequestOptions['searchParams']
): string {
  if (!searchParams) {
    return path
  }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams)) {
    params.set(key, String(value))
  }
  const query = params.toString()
  return query.length > 0 ? `${path}?${query}` : path
}

function responseHeaderRecord(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return headers
}

async function requestGtJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions
): Promise<{ data: T | null; headers: Record<string, string>; status: number }> {
  const response = await gtApiWithHeaders(
    [...gtRepoArgs(repo), gtRequestPath(path, options.searchParams)],
    { timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS }
  )
  const data = parseJsonBody<T>(response.body)
  return { data, headers: response.headers, status: response.status }
}

async function requestHttpJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions
): Promise<{ data: T | null; headers: Record<string, string>; status: number }> {
  const token = directApiToken()
  const response = await fetch(
    apiUrl(configuredGiteaApiBaseUrl(repo), path, options.searchParams),
    {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `token ${token}` } : {})
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    }
  )
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return { data: null, headers: responseHeaderRecord(response), status: response.status }
  }
  const data: T = await response.json()
  return {
    data,
    headers: responseHeaderRecord(response),
    status: response.status
  }
}

function parseJsonBody<T>(body: string): T | null {
  if (body.trim().length === 0) {
    return null
  }
  const data: T = JSON.parse(body)
  return data
}

function failedRequest(
  status: number,
  options: GiteaJsonRequestOptions,
  throwOnFailure: boolean
): null {
  if (throwOnFailure && !(options.allowNotFound && status === 404)) {
    throw new Error(`Gitea request failed: HTTP ${status}`)
  }
  return null
}

async function executeGiteaJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions
): Promise<{ data: T | null; headers: Record<string, string>; status: number }> {
  return prefersGtApi(repo)
    ? requestGtJson<T>(repo, path, options)
    : requestHttpJson<T>(repo, path, options)
}

export async function requestGiteaJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions = {},
  throwOnFailure = false
): Promise<T | null> {
  try {
    const { data, status } = await executeGiteaJson<T>(repo, path, options)
    if (data !== null) {
      return data
    }
    return failedRequest(status, options, throwOnFailure)
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  }
}

export async function requestGiteaJsonWithHeaders<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions = {},
  throwOnFailure = false
): Promise<{ data: T | null; headers: Record<string, string> }> {
  try {
    const { data, headers, status } = await executeGiteaJson<T>(repo, path, options)
    if (data !== null) {
      return { data, headers }
    }
    failedRequest(status, options, throwOnFailure)
    return { data: null, headers }
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return { data: null, headers: {} }
  }
}

export async function requestGiteaTextResult(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions = {}
): Promise<{ text: string | null; status: number }> {
  try {
    if (prefersGtApi(repo)) {
      const response = await gtApiWithHeaders(
        [...gtRepoArgs(repo), gtRequestPath(path, options.searchParams)],
        { timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS }
      )
      return { text: response.body, status: response.status }
    }
    const token = directApiToken()
    const response = await fetch(
      apiUrl(configuredGiteaApiBaseUrl(repo), path, options.searchParams),
      {
        headers: {
          Accept: 'text/plain, application/json',
          ...(token ? { Authorization: `token ${token}` } : {})
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      }
    )
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      return { text: null, status: response.status }
    }
    const text = await response.text()
    return { text, status: response.status }
  } catch {
    return { text: null, status: 0 }
  }
}

export async function requestGiteaText(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions = {}
): Promise<string | null> {
  const result = await requestGiteaTextResult(repo, path, options)
  return result.status >= 200 && result.status < 300 ? result.text : null
}

export async function postGiteaHttpJson(
  repo: GiteaRepoRef,
  path: string,
  body: unknown,
  options: GiteaJsonRequestOptions = {}
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const token = directApiToken()
  try {
    const response = await fetch(
      apiUrl(configuredGiteaApiBaseUrl(repo), path, options.searchParams),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `token ${token}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      }
    )
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      return { ok: false, error: `Gitea request failed: HTTP ${response.status}` }
    }
    const data = await response.json()
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeGiteaJson(
  repo: GiteaRepoRef,
  method: 'PATCH' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  options: GiteaJsonRequestOptions = {}
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const token = directApiToken()
  try {
    const response = await fetch(
      apiUrl(configuredGiteaApiBaseUrl(repo), path, options.searchParams),
      {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          Accept: 'application/json',
          ...(token ? { Authorization: `token ${token}` } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      }
    )
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      return { ok: false, error: `Gitea request failed: HTTP ${response.status}` }
    }
    const data = response.status === 204 ? null : await response.json().catch(() => null)
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
