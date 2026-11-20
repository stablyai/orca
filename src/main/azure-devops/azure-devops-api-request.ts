import type { AzureDevOpsRepoRef } from './repository-ref'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { isAzureDevOpsOrganizationName } from '../../shared/git/remotes/azure-devops-organization-name'
import { AzureDevOpsAuthError } from './azure-cli-access-token'
import {
  assertAzureDevOpsCredentialsCurrent,
  getAzureDevOpsAuthMethod,
  invalidateAzureDevOpsCredentials,
  resolveAzureDevOpsCredentials,
  type AzureDevOpsCredentials
} from './azure-devops-credentials'

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

export type AzureDevOpsRequestOptions = {
  searchParams?: Record<string, string | number>
  timeoutMs?: number
  onResponse?: (response: Response) => void
}

export function normalizeAzureDevOpsApiBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/_apis$/i, '')
}

export function getConfiguredAzureDevOpsApiBaseUrl(): string | null {
  return process.env.ORCA_AZURE_DEVOPS_API_BASE_URL?.trim() || null
}

export function assertAzureDevOpsCliEndpoint(destination: string | URL): void {
  const url = typeof destination === 'string' ? URL.parse(destination) : destination
  if (!url) {
    throw new AzureDevOpsAuthError('unsupported-endpoint')
  }
  const legacySuffix = '.visualstudio.com'
  const host = url.hostname
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    (host !== 'dev.azure.com' &&
      !(
        host.endsWith(legacySuffix) &&
        isAzureDevOpsOrganizationName(host.slice(0, -legacySuffix.length))
      ))
  ) {
    throw new AzureDevOpsAuthError('unsupported-endpoint')
  }
}

export class AzureDevOpsHttpError extends Error {
  constructor(readonly status: number) {
    super(`Azure DevOps request failed: HTTP ${status}`)
    this.name = 'AzureDevOpsHttpError'
  }
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
  const configured = getConfiguredAzureDevOpsApiBaseUrl()
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
    'api-version': azureDevOpsApiVersionForOrigin(url.origin)
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
  throwOnFailure = false,
  initialCredentials?: AzureDevOpsCredentials
): Promise<T | null> {
  try {
    if (getAzureDevOpsAuthMethod() === 'azure-cli') {
      assertAzureDevOpsCliEndpoint(baseUrl)
    }
    let credentials = initialCredentials ?? (await resolveAzureDevOpsCredentials())
    let refreshed = false
    for (let attempt = 1; ;) {
      const url = apiUrl(baseUrl, path, options.searchParams)
      assertAzureDevOpsCredentialsCurrent(credentials)
      const cli = credentials.method === 'azure-cli' ? credentials : null
      if (cli) {
        assertAzureDevOpsCliEndpoint(url)
      }
      const response = await fetch(url, {
        headers: { Accept: 'application/json', ...credentials.headers },
        ...(cli ? { redirect: 'error' } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      })
      if (response.ok) {
        options.onResponse?.(response)
        return (await response.json()) as T
      }
      const body = response.status === 400 ? await response.text().catch(() => '') : ''
      await cancelUnreadResponseBody(response)
      if (cli && response.status === 401) {
        invalidateAzureDevOpsCredentials({ generation: cli.generation })
        if (!refreshed) {
          refreshed = true
          credentials = await resolveAzureDevOpsCredentials()
          if (credentials.method !== 'azure-cli') {
            throw new AzureDevOpsHttpError(401)
          }
          continue
        }
      }
      if (
        attempt >= AZURE_DEVOPS_MAX_REQUEST_ATTEMPTS ||
        !recordAzureDevOpsApiVersionRejection(url, response.status, body)
      ) {
        if (throwOnFailure) {
          throw new AzureDevOpsHttpError(response.status)
        }
        return null
      }
      attempt++
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
