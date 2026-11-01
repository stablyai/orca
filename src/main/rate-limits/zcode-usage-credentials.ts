import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  readZcodeV2PlanCredential,
  localZcodeCredentialHost,
  type ZcodeCredentialHost
} from '../zcode/zcode-v2-plan-credentials'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

const SUPPORTED_HOSTS = new Set(['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn'])
const CREDENTIAL_IDENTITY_KEY = randomBytes(32)
export const ZCODE_PLAN_CREDENTIAL_SOURCE = 'orca-plan'
export type ZcodePlanCredential = { apiKey: string; baseUrl: string }
export type ZcodeUsageCredentials = { apiKey: string; quotaUrl: string; authProvenance: string }
export type ZcodeUsageCredentialOptions = {
  configPath?: string
  credentialHost?: ZcodeCredentialHost
}
export type ZcodeUsageCredentialRead =
  | { status: 'unavailable' | 'error' }
  | { status: 'ok'; credentials: ZcodeUsageCredentials; source: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function readMainProvider(model: unknown): string | null {
  const name = typeof model === 'string' ? model : readRecord(model)?.main
  if (typeof name !== 'string') {
    return null
  }
  const delimiter = name.indexOf('/')
  return delimiter > 0 && delimiter < name.length - 1 ? name.slice(0, delimiter) : null
}
function readCredentials(configPath: string): ZcodeUsageCredentials | null {
  let config: Record<string, unknown> | null
  try {
    config = readRecord(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch {
    return null
  }

  if (!config) {
    return null
  }
  // A quota from another configured account must never appear as the selected model's quota.
  const mainProvider = readMainProvider(config.model)
  if (!mainProvider) {
    return null
  }
  const options = readRecord(readRecord(readRecord(config.provider)?.[mainProvider])?.options)
  const apiKey = options?.apiKey
  const baseURL = options?.baseURL
  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    /[\r\n]/.test(apiKey) ||
    typeof baseURL !== 'string'
  ) {
    return null
  }
  return resolveUsageCredentials(apiKey, baseURL, mainProvider)
}

export function resolveUsageCredentials(
  key: string,
  baseUrl: string,
  identity: string
): ZcodeUsageCredentials | null {
  const apiKey = key.trim()
  if (!apiKey || /[\r\n]/.test(apiKey)) {
    return null
  }
  try {
    const parsed = new URL(baseUrl)
    if (
      parsed.protocol !== 'https:' ||
      !SUPPORTED_HOSTS.has(parsed.hostname) ||
      (parsed.port !== '' && parsed.port !== '443')
    ) {
      return null
    }
    return {
      apiKey,
      quotaUrl: `${parsed.origin}/api/monitor/usage/quota/limit`,
      authProvenance: createHmac('sha256', CREDENTIAL_IDENTITY_KEY)
        .update(JSON.stringify([identity, parsed.origin, apiKey]))
        .digest('hex')
    }
  } catch {
    return null
  }
}

export function readZcodeUsageCredentials(
  options: ZcodeUsageCredentialOptions = {}
): ZcodeUsageCredentialRead {
  const host = options.credentialHost ?? localZcodeCredentialHost()
  const configPath = options.configPath ?? join(host.home, '.zcode', 'cli', 'config.json')
  // An explicit legacy fixture path never probes the developer's credential store.
  const v2 =
    options.configPath && !options.credentialHost
      ? { status: 'absent' as const }
      : readZcodeV2PlanCredential(host)
  if (v2.status === 'error') {
    return { status: 'error' }
  }
  if (v2.status === 'unavailable') {
    return { status: 'unavailable' }
  }
  const credentials =
    v2.status === 'ok'
      ? resolveUsageCredentials(v2.apiKey, v2.baseUrl, v2.identity)
      : readCredentials(configPath)
  return credentials
    ? { status: 'ok', credentials, source: v2.status === 'ok' ? v2.configPath : configPath }
    : { status: 'unavailable' }
}

export function hasZcodeCliPlanCredentials(configPath?: string): boolean {
  return readZcodeUsageCredentials({ configPath }).status === 'ok'
}

export function isZcodeUsageCredentialCurrent(usage: ProviderRateLimits): boolean {
  if (
    !usage.usageMetadata?.authProvenance ||
    !usage.usageMetadata.credentialSource ||
    usage.usageMetadata.credentialSource === ZCODE_PLAN_CREDENTIAL_SOURCE
  ) {
    return true
  }
  const current = readZcodeUsageCredentials()
  return (
    current.status === 'ok' &&
    current.credentials.authProvenance === usage.usageMetadata.authProvenance
  )
}
