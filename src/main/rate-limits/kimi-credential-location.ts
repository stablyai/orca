import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_OAUTH_HOST = 'https://auth.kimi.com'
const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1'

export type KimiCredentialLocation = {
  home: string
  oauthHost: string
  baseUrl: string
  storageName: string
  credentialsPath: string
  lockTarget: string
  tokenUrl: string
  usageUrl: string
}

type KimiEnvironment = Partial<Record<string, string | undefined>>

export function resolveKimiCredentialLocation(
  env: KimiEnvironment = process.env,
  fallbackHome = homedir()
): KimiCredentialLocation {
  const home = env.KIMI_CODE_HOME || join(fallbackHome, '.kimi-code')
  const oauthHost = (env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST ?? DEFAULT_OAUTH_HOST)
    .trim()
    .replace(/\/+$/, '')
  // Why: match oauthHost trimming so whitespace in KIMI_CODE_BASE_URL cannot
  // skew storageName hashing or produce a malformed usageUrl.
  const baseUrl = (env.KIMI_CODE_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  const isDefault = oauthHost === DEFAULT_OAUTH_HOST && baseUrl === DEFAULT_BASE_URL
  const suffix = isDefault
    ? ''
    : `-env-${createHash('sha256')
        .update(JSON.stringify({ oauthHost, baseUrl }))
        .digest('hex')
        .slice(0, 16)}`
  const storageName = `kimi-code${suffix}`

  return {
    home,
    oauthHost,
    baseUrl,
    storageName,
    credentialsPath: join(home, 'credentials', `${storageName}.json`),
    lockTarget: join(home, 'oauth', storageName),
    tokenUrl: `${oauthHost}/api/oauth/token`,
    usageUrl: `${baseUrl}/usages`
  }
}
