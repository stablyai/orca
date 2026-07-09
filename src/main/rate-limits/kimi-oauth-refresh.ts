import { renameSync, writeFileSync } from 'node:fs'
import { net } from 'electron'

const KIMI_OAUTH_HOST =
  process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST ?? 'https://auth.kimi.com'
const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const API_TIMEOUT_MS = 10_000

export type KimiCredentials = {
  access_token?: string
  refresh_token?: string
  expires_at?: number
  expires_in?: number
  scope?: string
  token_type?: string
  [key: string]: unknown
}

type KimiTokenEndpointResponse = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
  token_type?: unknown
}

function getKimiOAuthTokenUrl(): string {
  return `${KIMI_OAUTH_HOST.replace(/\/$/, '')}/api/oauth/token`
}

function applyRefreshedCredentials(
  credentials: KimiCredentials,
  response: KimiTokenEndpointResponse,
  nowSeconds: number
): KimiCredentials | null {
  if (typeof response.access_token !== 'string' || response.access_token.length === 0) {
    return null
  }
  if (typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in)) {
    return null
  }
  const refreshToken =
    typeof response.refresh_token === 'string' && response.refresh_token.length > 0
      ? response.refresh_token
      : credentials.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return null
  }
  return {
    ...credentials,
    access_token: response.access_token,
    refresh_token: refreshToken,
    expires_at: nowSeconds + response.expires_in,
    expires_in: response.expires_in,
    token_type:
      typeof response.token_type === 'string' && response.token_type.length > 0
        ? response.token_type
        : credentials.token_type,
    scope:
      typeof response.scope === 'string' && response.scope.length > 0
        ? response.scope
        : credentials.scope
  }
}

function saveCredentials(credentialsPath: string, credentials: KimiCredentials): void {
  const tmpPath = `${credentialsPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
  renameSync(tmpPath, credentialsPath)
}

export async function refreshKimiCredentials(
  credentials: KimiCredentials,
  credentialsPath: string
): Promise<KimiCredentials | null> {
  if (typeof credentials.refresh_token !== 'string' || credentials.refresh_token.length === 0) {
    return null
  }
  const res = await net.fetch(getKimiOAuthTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: KIMI_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refresh_token
    }).toString(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  if (!res.ok) {
    return null
  }
  const data = (await res.json()) as KimiTokenEndpointResponse
  const refreshed = applyRefreshedCredentials(credentials, data, Math.floor(Date.now() / 1000))
  if (!refreshed) {
    return null
  }
  // Why: Kimi Code rotates refresh tokens; persisting before /usages prevents a
  // short-lived in-memory success from stranding the next background refresh.
  saveCredentials(credentialsPath, refreshed)
  return refreshed
}
