import { Buffer } from 'node:buffer'
import type { AzureDevOpsRepoRef } from './repository-ref'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  getConfiguredAzureDevOpsApiBaseUrls,
  normalizeAzureDevOpsApiBaseUrl
} from './azure-devops-organization-base-urls'

const REQUEST_TIMEOUT_MS = 5000
const DEFAULT_API_VERSION = '7.1'

// Why (STA-3494): on-prem Azure DevOps Server rejects versioned requests without
// the -preview suffix; remember which origins need it after the first rejection.
const previewApiVersionOrigins = new Set<string>()

/** @internal - exposed for tests only */
export function _resetAzureDevOpsPreviewApiVersionCache(): void {
  previewApiVersionOrigins.clear()
}

export function markAzureDevOpsPreviewApiVersionOrigin(origin: string): void {
  previewApiVersionOrigins.add(origin)
}

export function azureDevOpsApiVersionForOrigin(
  origin: string,
  requested?: string | number
): string {
  const version = String(requested ?? DEFAULT_API_VERSION)
  return previewApiVersionOrigins.has(origin) && !version.endsWith('-preview')
    ? `${version}-preview`
    : version
}

export function isAzureDevOpsPreviewVersionRejection(status: number | null, body: string): boolean {
  if (status !== 400) {
    return false
  }
  try {
    const parsed = JSON.parse(body) as { typeKey?: unknown } | null
    return parsed?.typeKey === 'VssInvalidPreviewVersionException'
  } catch {
    return false
  }
}

type AzureDevOpsAuthConfig = {
  apiBaseUrl: string | null
  pat: string | null
  accessToken: string | null
  username: string | null
}

export type AzureDevOpsRequestOptions = {
  searchParams?: Record<string, string | number>
  timeoutMs?: number
  method?: 'GET' | 'POST' | 'PATCH'
  body?: unknown
  /** Azure DevOps needs `application/json-patch+json` for work item updates. */
  contentType?: string
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function getAzureDevOpsAuthConfig(): AzureDevOpsAuthConfig {
  return {
    // One base URL, never the raw list: every caller of this config addresses a
    // single origin. Selecting among the rest goes through
    // resolveAzureDevOpsApiBaseUrl.
    apiBaseUrl: getConfiguredAzureDevOpsApiBaseUrls()[0] ?? null,
    pat: envValue('ORCA_AZURE_DEVOPS_TOKEN') ?? envValue('ORCA_AZURE_DEVOPS_PAT'),
    accessToken: envValue('ORCA_AZURE_DEVOPS_ACCESS_TOKEN'),
    username: envValue('ORCA_AZURE_DEVOPS_USERNAME')
  }
}

export function azureDevOpsTokenConfigured(config: AzureDevOpsAuthConfig): boolean {
  return Boolean(config.pat || config.accessToken)
}

function authHeaders(config: AzureDevOpsAuthConfig): Record<string, string> {
  if (config.accessToken) {
    return { Authorization: `Bearer ${config.accessToken}` }
  }
  if (config.pat) {
    const encoded = Buffer.from(`${config.username ?? ''}:${config.pat}`).toString('base64')
    return { Authorization: `Basic ${encoded}` }
  }
  return {}
}

function isUrlPathAncestor(ancestor: string, descendant: string): boolean {
  try {
    const ancestorUrl = new URL(ancestor)
    const descendantUrl = new URL(descendant)
    const ancestorPath = ancestorUrl.pathname.replace(/\/+$/, '')
    const descendantPath = descendantUrl.pathname.replace(/\/+$/, '')
    return (
      ancestorUrl.origin === descendantUrl.origin &&
      (ancestorPath === descendantPath || descendantPath.startsWith(`${ancestorPath}/`))
    )
  } catch {
    return false
  }
}

export function resolveAzureDevOpsGitApiBaseUrl(repo: AzureDevOpsRepoRef): string {
  const configured = getAzureDevOpsAuthConfig().apiBaseUrl
  if (!configured) {
    return repo.apiBaseUrl
  }
  const normalized = normalizeAzureDevOpsApiBaseUrl(configured)
  // Why (STA-3494): a configured collection ancestor is the auth-probe URL;
  // Git endpoints need the project-level base derived from the remote.
  return isUrlPathAncestor(normalized, repo.apiBaseUrl) ? repo.apiBaseUrl : normalized
}

function apiUrl(
  baseUrl: string,
  path: string,
  searchParams?: AzureDevOpsRequestOptions['searchParams']
): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  const params = {
    ...searchParams,
    'api-version': azureDevOpsApiVersionForOrigin(url.origin, searchParams?.['api-version'])
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value))
  }
  return url
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Reads the body only for a 400 on a non-preview request, and only from a
// clone: a 400 that is not a preview rejection is still handed to the caller,
// which reads it for Azure's own validation message. Cloning here rather than
// at the call site keeps the unread-clone case from existing at all.
async function shouldRetryWithPreviewApiVersion(url: URL, response: Response): Promise<boolean> {
  if (response.ok || response.status !== 400) {
    return false
  }
  if (url.searchParams.get('api-version')?.endsWith('-preview')) {
    return false
  }
  try {
    const body: unknown = await response.clone().json()
    return isRecord(body) && body.typeKey === 'VssInvalidPreviewVersionException'
  } catch {
    return false
  }
}

async function fetchWithApiVersionRetry(
  baseUrl: string,
  path: string,
  options: AzureDevOpsRequestOptions
): Promise<Response> {
  const config = getAzureDevOpsAuthConfig()
  const method = options.method ?? 'GET'
  const hasBody = options.body !== undefined
  const doFetch = (url: URL): Promise<Response> =>
    fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': options.contentType ?? 'application/json' } : {}),
        ...authHeaders(config)
      },
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      // A same-origin redirect would carry this request, credential and all, to
      // a path the Boards proxy policy already checked and no longer governs.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    })
  const url = apiUrl(baseUrl, path, options.searchParams)
  const response = await doFetch(url)
  if (await shouldRetryWithPreviewApiVersion(url, response)) {
    // The retry replaces this response, so its body is never read.
    await cancelUnreadResponseBody(response)
    markAzureDevOpsPreviewApiVersionOrigin(url.origin)
    return doFetch(apiUrl(baseUrl, path, options.searchParams))
  }
  return response
}

export async function requestAzureDevOpsJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: AzureDevOpsRequestOptions = {},
  // Why: the existing-review lookup behind Create must distinguish a real
  // transport/auth failure from an accepted "no PR". When true, a failed request
  // throws instead of collapsing to null so callers never report false not_found.
  throwOnFailure = false
): Promise<T | null> {
  try {
    const response = await fetchWithApiVersionRetry(baseUrl, path, options)
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      if (throwOnFailure) {
        throw new Error(`Azure DevOps request failed: HTTP ${response.status}`)
      }
      return null
    }
    return (await response.json()) as T
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  }
}

export type AzureDevOpsResponse = { status: number; body: unknown }

/**
 * Status-preserving variant. `requestAzureDevOpsJsonAtBase` collapses every
 * failure to null or a generic Error, which loses the distinction between a
 * missing work item, an expired token, and a throttle. The Boards proxy needs
 * that distinction to report the right error code.
 */
export async function requestAzureDevOpsResponseAtBase(
  baseUrl: string,
  path: string,
  options: AzureDevOpsRequestOptions = {}
): Promise<AzureDevOpsResponse> {
  const response = await fetchWithApiVersionRetry(baseUrl, path, options)
  const text = await response.text()
  if (!text) {
    return { status: response.status, body: null }
  }
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    // Azure DevOps returns HTML for some auth failures; keep it as a string
    // rather than discarding the status that tells the caller what happened.
    return { status: response.status, body: text }
  }
}

export function requestAzureDevOpsJson<T>(
  repo: AzureDevOpsRepoRef,
  path: string,
  options: AzureDevOpsRequestOptions = {},
  throwOnFailure = false
): Promise<T | null> {
  return requestAzureDevOpsJsonAtBase(
    resolveAzureDevOpsGitApiBaseUrl(repo),
    path,
    options,
    throwOnFailure
  )
}
