import { Buffer } from 'node:buffer'
import type { AzureDevOpsRepoRef } from './repository-ref'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  getAzCliAzureDevOpsAccessToken,
  isEntraEligibleAzureDevOpsBaseUrl
} from './az-cli-access-token'

const REQUEST_TIMEOUT_MS = 5000
// Newest first: older on-prem Servers reject newer versions with VssVersionOutOfRangeException.
const API_VERSIONS: readonly string[] = ['7.1', '6.1', '5.1']
// Each retry either lowers the version or adds -preview once, so this bounds negotiation.
export const AZURE_DEVOPS_MAX_REQUEST_ATTEMPTS = API_VERSIONS.length + 1

// Remember origins that require the -preview API version suffix.
const previewApiVersionOrigins = new Set<string>()
const apiVersionIndexByOrigin = new Map<string, number>()

/** @internal - exposed for tests only */
export function _resetAzureDevOpsApiVersionCache(): void {
  previewApiVersionOrigins.clear()
  apiVersionIndexByOrigin.clear()
}

export function azureDevOpsApiVersionForOrigin(origin: string): string {
  const version = API_VERSIONS[apiVersionIndexByOrigin.get(origin) ?? 0]
  return previewApiVersionOrigins.has(origin) ? `${version}-preview` : version
}

function errorTypeKey(body: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null && 'typeKey' in parsed
      ? parsed.typeKey
      : null
  } catch {
    return null
  }
}

/** Returns true when the rejected request should be retried with the newly negotiated version. */
export function recordAzureDevOpsApiVersionRejection(
  url: URL,
  status: number | null,
  body: string
): boolean {
  const typeKey = status === 400 ? errorTypeKey(body) : null
  const requested = url.searchParams.get('api-version') ?? ''
  if (typeKey === 'VssInvalidPreviewVersionException' && !requested.endsWith('-preview')) {
    previewApiVersionOrigins.add(url.origin)
    return true
  }
  if (typeKey !== 'VssVersionOutOfRangeException') {
    return false
  }
  const next = API_VERSIONS.indexOf(requested.replace(/-preview$/, '')) + 1
  if (next === 0 || next >= API_VERSIONS.length) {
    return false
  }
  // Never move back up: a concurrent request may already have negotiated lower.
  apiVersionIndexByOrigin.set(
    url.origin,
    Math.max(next, apiVersionIndexByOrigin.get(url.origin) ?? 0)
  )
  return true
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
  method?: 'GET' | 'POST'
  body?: unknown
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

function envAuthHeaders(config: AzureDevOpsAuthConfig): Record<string, string> {
  if (config.accessToken) {
    return { Authorization: `Bearer ${config.accessToken}` }
  }
  if (config.pat) {
    const encoded = Buffer.from(`${config.username ?? ''}:${config.pat}`).toString('base64')
    return { Authorization: `Basic ${encoded}` }
  }
  return {}
}

/**
 * Env tokens win; otherwise hosted Azure DevOps falls back to the az CLI's
 * Entra login. On-prem Azure DevOps Server never tries az — it only accepts
 * PAT/Windows auth.
 */
export async function resolveAzureDevOpsAuthHeaders(
  baseUrl: string
): Promise<Record<string, string>> {
  const config = getAzureDevOpsAuthConfig()
  const fromEnv = envAuthHeaders(config)
  if (Object.keys(fromEnv).length > 0) {
    return fromEnv
  }
  if (!isEntraEligibleAzureDevOpsBaseUrl(baseUrl)) {
    return {}
  }
  const token = await getAzCliAzureDevOpsAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
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
  // Git endpoints need the remote's project path, even when auth probes use a collection URL.
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
    // Why: a pinned version names an endpoint that exists only there; negotiation is for the rest.
    'api-version': searchParams?.['api-version'] ?? azureDevOpsApiVersionForOrigin(url.origin)
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value))
  }
  return url
}

export async function requestAzureDevOpsJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: AzureDevOpsRequestOptions = {},
  // Creation preflight must distinguish lookup failure from an absent PR.
  throwOnFailure = false
): Promise<T | null> {
  const doFetch = async (url: URL): Promise<Response> =>
    fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(await resolveAzureDevOpsAuthHeaders(baseUrl))
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    })
  try {
    for (let attempt = 1; ; attempt++) {
      const url = apiUrl(baseUrl, path, options.searchParams)
      const response = await doFetch(url)
      if (response.ok) {
        return (await response.json()) as T
      }
      const body = response.status === 400 ? await response.text().catch(() => '') : ''
      await cancelUnreadResponseBody(response)
      if (
        attempt >= AZURE_DEVOPS_MAX_REQUEST_ATTEMPTS ||
        options.searchParams?.['api-version'] !== undefined ||
        !recordAzureDevOpsApiVersionRejection(url, response.status, body)
      ) {
        if (throwOnFailure) {
          throw new Error(`Azure DevOps request failed: HTTP ${response.status}`)
        }
        return null
      }
    }
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
