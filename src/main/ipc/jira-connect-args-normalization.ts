import type { JiraConnectArgs } from '../../shared/types'

const CLOUD_CONNECT_KEYS = new Set(['deploymentType', 'siteUrl', 'email', 'apiToken'])
const SERVER_BASIC_CONNECT_KEYS = new Set([
  'deploymentType',
  'authMode',
  'siteUrl',
  'username',
  'passwordOrToken'
])
const SERVER_BEARER_CONNECT_KEYS = new Set(['deploymentType', 'authMode', 'siteUrl', 'bearerToken'])

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowedKeys.has(key))
}

function normalizeRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeCloudConnectArgs(input: Record<string, unknown>): JiraConnectArgs | null {
  if (!hasOnlyKeys(input, CLOUD_CONNECT_KEYS)) {
    return null
  }
  const siteUrl = normalizeRequiredString(input.siteUrl)
  const email = normalizeRequiredString(input.email)
  const apiToken = normalizeRequiredString(input.apiToken)
  return siteUrl && email && apiToken ? { deploymentType: 'cloud', siteUrl, email, apiToken } : null
}

function normalizeServerBasicConnectArgs(input: Record<string, unknown>): JiraConnectArgs | null {
  if (!hasOnlyKeys(input, SERVER_BASIC_CONNECT_KEYS)) {
    return null
  }
  const siteUrl = normalizeRequiredString(input.siteUrl)
  const username = normalizeRequiredString(input.username)
  const passwordOrToken = normalizeRequiredString(input.passwordOrToken)
  return siteUrl && username && passwordOrToken
    ? { deploymentType: 'server', authMode: 'basic', siteUrl, username, passwordOrToken }
    : null
}

function normalizeServerBearerConnectArgs(input: Record<string, unknown>): JiraConnectArgs | null {
  if (!hasOnlyKeys(input, SERVER_BEARER_CONNECT_KEYS)) {
    return null
  }
  const siteUrl = normalizeRequiredString(input.siteUrl)
  const bearerToken = normalizeRequiredString(input.bearerToken)
  return siteUrl && bearerToken
    ? { deploymentType: 'server', authMode: 'bearer', siteUrl, bearerToken }
    : null
}

export function normalizeConnectArgs(value: unknown): JiraConnectArgs | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as Record<string, unknown>
  // Why: older renderer/runtime callers omitted deploymentType before Server/DC support.
  const deploymentType = input.deploymentType ?? 'cloud'
  if (deploymentType === 'cloud') {
    return normalizeCloudConnectArgs(input)
  }
  if (deploymentType !== 'server') {
    return null
  }
  if (input.authMode === 'basic') {
    return normalizeServerBasicConnectArgs(input)
  }
  if (input.authMode === 'bearer') {
    return normalizeServerBearerConnectArgs(input)
  }
  return null
}
