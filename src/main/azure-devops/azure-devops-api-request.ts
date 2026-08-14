import { Buffer } from 'node:buffer'
import type { AzureDevOpsRepoRef } from './repository-ref'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

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
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function normalizeAzureDevOpsApiBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/_apis$/i, '')
}

export function getAzureDevOpsAuthConfig(): AzureDevOpsAuthConfig {
  return {
    apiBaseUrl: envValue('ORCA_AZURE_DEVOPS_API_BASE_URL'),
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

// Reads the body only for a 400 on a non-preview request; consumed either way.
async function shouldRetryWithPreviewApiVersion(url: URL, response: Response): Promise<boolean> {
  if (response.ok || response.status !== 400) {
    return false
  }
  if (url.searchParams.get('api-version')?.endsWith('-preview')) {
    return false
  }
  try {
    const body = (await response.json()) as { typeKey?: string | null } | null
    return body?.typeKey === 'VssInvalidPreviewVersionException'
  } catch {
    return false
  }
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
  const config = getAzureDevOpsAuthConfig()
  const doFetch = (url: URL): Promise<Response> =>
    fetch(url, {
      headers: {
        Accept: 'application/json',
        ...authHeaders(config)
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    })
  try {
    const url = apiUrl(baseUrl, path, options.searchParams)
    let response = await doFetch(url)
    if (await shouldRetryWithPreviewApiVersion(url, response)) {
      markAzureDevOpsPreviewApiVersionOrigin(url.origin)
      response = await doFetch(apiUrl(baseUrl, path, options.searchParams))
    }
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
