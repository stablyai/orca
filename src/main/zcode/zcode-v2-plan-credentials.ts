import { createDecipheriv, createHash } from 'node:crypto'
import { homedir, platform, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { ZCODE_PLAN_SITE_BASE_URLS } from '../../shared/zcode-plan-sites'
import { readSupportedZcodeV2Selection } from './zcode-v2-personal-overlay'

const MAX_V2_FILE_BYTES = 4 * 1024 * 1024
function readV2File(path: string): string {
  return readNodeFileSyncWithinLimit(path, MAX_V2_FILE_BYTES, {
    regularFileOnly: true
  }).buffer.toString('utf8')
}

const credentialSchema = z.record(z.string(), z.string())
const oauthAccountSchema = z.looseObject({ id: z.string().trim().min(1) })
const sites = new Map([
  ['account:zai-individual-coding-plan', 'zai'],
  ['account:bigmodel-individual-coding-plan', 'bigmodel']
] as const)

export type ZcodeCredentialHost = {
  home: string
  platform: string
  username: string
  env: NodeJS.ProcessEnv
}

export type ZcodeV2PlanCredential =
  | { status: 'absent' | 'unavailable' | 'error' }
  | { status: 'ok'; apiKey: string; baseUrl: string; identity: string; configPath: string }

export function localZcodeCredentialHost(): ZcodeCredentialHost {
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    // Upstream uses the same fallback in sandboxed hosts.
  }
  return { home: homedir(), platform: platform(), username, env: process.env }
}

function userPath(value: string, home: string): string {
  if (value === '~') {
    return home
  }
  return value.startsWith('~/') ? join(home, value.slice(2)) : resolve(value)
}

export function resolveZcodeDataBaseDir(host: ZcodeCredentialHost): string {
  return userPath(host.env.ZCODE_DATA_BASE_DIR ?? host.home, host.home)
}

// Read-only enc:v1 compatibility with ZCode 29628c9 credential-cipher.ts.
export function decryptZcodeV2CredentialValue(
  value: string,
  host: ZcodeCredentialHost = localZcodeCredentialHost()
): string {
  if (!value.startsWith('enc:v1:')) {
    return value
  }
  const parts = value.slice(7).split('.')
  const [nonce, tag, ciphertext] = parts
  if (parts.length !== 3 || !nonce || !tag || !ciphertext) {
    throw new Error('Invalid credential')
  }
  const iv = Buffer.from(nonce, 'base64url')
  const authTag = Buffer.from(tag, 'base64url')
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error('Invalid credential')
  }
  const secret =
    host.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${host.platform}:${host.home}:${host.username}`
  const key = createHash('sha256').update(secret).digest()
  const cipher = createDecipheriv('aes-256-gcm', key, iv)
  cipher.setAuthTag(authTag)
  return Buffer.concat([
    cipher.update(Buffer.from(ciphertext, 'base64url')),
    cipher.final()
  ]).toString('utf8')
}

function readOAuthPlanCredential(
  store: Record<string, string>,
  host: ZcodeCredentialHost,
  configPath: string
): ZcodeV2PlanCredential | null {
  const rawFamily = store['oauth:active_provider']
  if (!rawFamily) {
    return null
  }
  const family = decryptZcodeV2CredentialValue(rawFamily, host).trim()
  if (family !== 'zai' && family !== 'bigmodel') {
    return { status: 'unavailable' }
  }
  const rawUserInfo = store[`oauth:${family}:user_info`]
  if (!rawUserInfo) {
    return { status: 'unavailable' }
  }
  const account = oauthAccountSchema.safeParse(
    JSON.parse(decryptZcodeV2CredentialValue(rawUserInfo, host))
  )
  if (!account.success) {
    return { status: 'unavailable' }
  }
  const providerId = `account:${family}-individual-coding-plan`
  const rawKey =
    store[
      `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(account.data.id)}:api-key`
    ]
  if (!rawKey) {
    return { status: 'unavailable' }
  }
  const apiKey = decryptZcodeV2CredentialValue(rawKey, host).trim()
  if (!apiKey || /[\r\n]/.test(apiKey)) {
    return { status: 'error' }
  }
  return {
    status: 'ok',
    apiKey,
    baseUrl: ZCODE_PLAN_SITE_BASE_URLS[family],
    identity: JSON.stringify([family, account.data.id]),
    configPath
  }
}

export function readZcodeV2PlanCredential(
  host = localZcodeCredentialHost()
): ZcodeV2PlanCredential {
  const base = resolveZcodeDataBaseDir(host)
  const configPath =
    (host.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
      ? userPath(host.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.trim(), host.home)
      : '') || join(base, '.zcode', 'v2', 'provider_config.json')
  let rawConfig: string
  try {
    rawConfig = readV2File(configPath)
  } catch (error) {
    return {
      status:
        error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'error'
    }
  }
  let selection: ReturnType<typeof readSupportedZcodeV2Selection>
  try {
    selection = readSupportedZcodeV2Selection(JSON.parse(rawConfig))
  } catch {
    return { status: 'error' }
  }
  if (selection.status === 'unsupported') {
    return { status: 'unavailable' }
  }
  let rawCredentials: string
  try {
    rawCredentials = readV2File(join(base, '.zcode', 'v2', 'credentials.json'))
  } catch (error) {
    return {
      status:
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'unavailable'
          : 'error'
    }
  }
  try {
    const store = credentialSchema.parse(JSON.parse(rawCredentials))
    const oauth = readOAuthPlanCredential(store, host, configPath)
    if (oauth) {
      return oauth
    }
    if (!selection.selection) {
      return { status: 'unavailable' }
    }
    const selected = selection.selection
    const site = [...sites].find(([provider]) => provider === selected.providerId)?.[1]
    if (!site) {
      return { status: 'unavailable' }
    }
    const rawIdentity = store[`account-provider:${selected.providerId}:identity`]
    if (!rawIdentity) {
      return { status: 'unavailable' }
    }
    const identity = decryptZcodeV2CredentialValue(rawIdentity, host).trim()
    if (!identity) {
      return { status: 'unavailable' }
    }
    const rawKey =
      store[
        `account-provider:coding-plan:${selected.providerId}:account:${encodeURIComponent(identity)}:api-key`
      ]
    if (!rawKey) {
      return { status: 'unavailable' }
    }
    const apiKey = decryptZcodeV2CredentialValue(rawKey, host).trim()
    if (!apiKey || /[\r\n]/.test(apiKey)) {
      return { status: 'error' }
    }
    return {
      status: 'ok',
      apiKey,
      baseUrl: ZCODE_PLAN_SITE_BASE_URLS[site],
      identity: JSON.stringify([selected.providerId, identity]),
      configPath
    }
  } catch {
    return { status: 'error' }
  }
}
