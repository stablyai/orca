import { net } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import {
  getGrokHome,
  isGrokAccessTokenFresh,
  readGrokAuthSession,
  type GrokAuthReadResult
} from './grok-auth'

export async function readGrokAuthSessionForUsage(options: {
  authReadResult?: GrokAuthReadResult
  authHome?: string
}): Promise<GrokAuthReadResult> {
  const result = options.authReadResult ?? readGrokAuthSession()
  return result.status === 'ok' &&
    !isGrokAccessTokenFresh(result.session) &&
    (options.authHome || !options.authReadResult)
    ? await renewGrokAuthSession(options.authHome ?? getGrokHome())
    : result
}

const renewals = new Map<string, Promise<GrokAuthReadResult>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function renew(home: string): Promise<GrokAuthReadResult> {
  const current = readGrokAuthSession(home)
  if (current.status !== 'ok' || isGrokAccessTokenFresh(current.session)) {
    return current
  }
  try {
    const path = join(home, 'auth.json')
    const original = readFileSync(path, 'utf8')
    const document: unknown = JSON.parse(original)
    if (!isRecord(document)) {
      return current
    }
    const entry = Object.entries(document).find(
      ([issuer, value]) =>
        (issuer === 'https://auth.x.ai' || issuer.startsWith('https://auth.x.ai::')) &&
        isRecord(value) &&
        value.key === current.session.accessToken
    )
    if (!entry) {
      return current
    }
    const [issuer, token] = entry
    if (!isRecord(token)) {
      return current
    }
    const clientId = current.session.oidcClientId ?? issuer.split('::')[1]
    if (typeof token.refresh_token !== 'string' || !clientId) {
      return current
    }
    const response = await net.fetch('https://auth.x.ai/oauth2/token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
        client_id: clientId
      }).toString()
    })
    if (!response.ok) {
      throw new Error('renewal failed')
    }
    const result: unknown = await response.json()
    if (!isRecord(result) || typeof result.access_token !== 'string') {
      throw new Error('invalid token')
    }
    const claims: unknown = JSON.parse(
      Buffer.from(result.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')
    )
    if (
      !isRecord(claims) ||
      claims.sub !== current.session.userId ||
      claims.iss !== 'https://auth.x.ai' ||
      typeof claims.exp !== 'number' ||
      !Number.isFinite(claims.exp)
    ) {
      throw new Error('identity changed')
    }
    document[issuer] = {
      ...token,
      key: result.access_token,
      expires_at: new Date(claims.exp * 1000).toISOString(),
      ...(typeof result.refresh_token === 'string' ? { refresh_token: result.refresh_token } : {})
    }
    // Keep a CLI refresh or logout that happened while the request was in flight.
    writeFileAtomicallyIfUnchanged(path, original, JSON.stringify(document), { mode: 0o600 })
    return readGrokAuthSession(home)
  } catch {
    return {
      status: 'error',
      error: 'Unable to renew Grok sign-in. Try again, or sign in to this account again.'
    }
  }
}

export function renewGrokAuthSession(home: string): Promise<GrokAuthReadResult> {
  const pending = renewals.get(home)
  if (pending) {
    return pending
  }
  const task = renew(home).finally(() => renewals.delete(home))
  renewals.set(home, task)
  return task
}
