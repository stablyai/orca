import { Buffer } from 'node:buffer'
import type { AzureDevOpsRepoRef } from './repository-ref'

const REQUEST_TIMEOUT_MS = 5000

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

function configuredApiBaseUrl(repo: AzureDevOpsRepoRef): string {
  const configured = getAzureDevOpsAuthConfig().apiBaseUrl
  return configured ? normalizeAzureDevOpsApiBaseUrl(configured) : repo.apiBaseUrl
}

function apiUrl(
  baseUrl: string,
  path: string,
  searchParams?: AzureDevOpsRequestOptions['searchParams']
): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  const params = { ...searchParams, 'api-version': searchParams?.['api-version'] ?? '7.1' }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value))
  }
  return url
}

export async function requestAzureDevOpsJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: AzureDevOpsRequestOptions = {}
): Promise<T | null> {
  const config = getAzureDevOpsAuthConfig()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(apiUrl(baseUrl, path, options.searchParams), {
      headers: {
        Accept: 'application/json',
        ...authHeaders(config)
      },
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

export function requestAzureDevOpsJson<T>(
  repo: AzureDevOpsRepoRef,
  path: string,
  options: AzureDevOpsRequestOptions = {}
): Promise<T | null> {
  return requestAzureDevOpsJsonAtBase(configuredApiBaseUrl(repo), path, options)
}
