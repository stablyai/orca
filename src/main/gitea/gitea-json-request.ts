import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { teaRepoArgs, type GiteaRepoRef } from './repository-ref'
import { teaApiWithHeaders } from './tea-api-response'

export function normalizeGiteaApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

const REQUEST_TIMEOUT_MS = 5000

export type GiteaJsonRequestOptions = {
  searchParams?: Record<string, string | number>
  timeoutMs?: number
  // Why: only a single-resource fetch may read 404 as "absent".
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

/** Direct HTTP wins when either Orca or tea named the token; otherwise a matched login uses `tea api`. */
function directApiToken(): string | null {
  return envValue('ORCA_GITEA_TOKEN') ?? envValue('GITEA_TOKEN')
}

function prefersTeaApi(repo: GiteaRepoRef): boolean {
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

function teaRequestPath(
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

async function requestTeaJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions
): Promise<{ data: T | null; headers: Record<string, string>; status: number }> {
  const response = await teaApiWithHeaders(
    [...teaRepoArgs(repo), teaRequestPath(path, options.searchParams)],
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
  return prefersTeaApi(repo)
    ? requestTeaJson<T>(repo, path, options)
    : requestHttpJson<T>(repo, path, options)
}

export async function requestGiteaJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions = {},
  throwOnFailure = false
): Promise<T | null> {
  try {
    const response = await executeGiteaJson<T>(repo, path, options)
    if (response.status < 200 || response.status >= 300 || response.data === null) {
      return failedRequest(response.status, options, throwOnFailure)
    }
    return response.data
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  }
}

export type GiteaTextResult = {
  status: number
  text: string | null
}

async function requestTeaText(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions
): Promise<GiteaTextResult> {
  const response = await teaApiWithHeaders(
    [...teaRepoArgs(repo), teaRequestPath(path, options.searchParams)],
    { timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS }
  )
  if (response.status < 200 || response.status >= 300) {
    return { status: response.status, text: null }
  }
  return { status: response.status, text: response.body }
}

async function requestHttpText(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions
): Promise<GiteaTextResult> {
  const token = directApiToken()
  const response = await fetch(
    apiUrl(configuredGiteaApiBaseUrl(repo), path, options.searchParams),
    {
      headers: {
        Accept: 'text/plain',
        ...(token ? { Authorization: `token ${token}` } : {})
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    }
  )
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return { status: response.status, text: null }
  }
  return { status: response.status, text: await response.text() }
}

/** Status stays visible so a missing Actions log (HTTP 404) is not the same as a transport failure. */
export async function requestGiteaTextResult(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions = {}
): Promise<GiteaTextResult> {
  try {
    return prefersTeaApi(repo)
      ? await requestTeaText(repo, path, options)
      : await requestHttpText(repo, path, options)
  } catch {
    return { status: 0, text: null }
  }
}

export async function requestGiteaText(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions = {}
): Promise<string | null> {
  const result = await requestGiteaTextResult(repo, path, options)
  return result.text
}

export async function requestGiteaJsonWithHeaders<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaJsonRequestOptions = {}
): Promise<{ data: T; headers: Record<string, string> }> {
  const response = await executeGiteaJson<T>(repo, path, options)
  if (response.status < 200 || response.status >= 300 || response.data === null) {
    throw new Error(`Gitea request failed: HTTP ${response.status}`)
  }
  return { data: response.data, headers: response.headers }
}
