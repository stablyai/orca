// Ending a sign-in: gone from this computer first, then the app is asked to end it (RFC 7009), in
// the background and with short deadlines, so a dead endpoint never holds up a removal.
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  commitBotToolOAuth,
  type BotToolOAuthEntry,
  type BotToolOAuthRecord
} from '../bot-tool-credentials'
import {
  REVOKE_DEADLINE_MS,
  extra,
  fetchFor,
  inTransaction,
  type BotToolOAuthKey
} from './bot-tool-oauth'
import { issuerMetadata } from './bot-tool-oauth-discovery'

/**
 * Signs the tool out: the tokens are gone from this computer before the app is asked to end them,
 * and anything still running for the old sign-in can no longer commit. The registration stays.
 */
export async function signOutBotTool(key: BotToolOAuthKey): Promise<void> {
  let old: BotToolOAuthEntry | null = null
  await inTransaction(key, () =>
    commitBotToolOAuth(key.folder, key.credentialId, (current) => {
      if (!current) {
        return undefined
      }
      old = current
      const {
        tokens: _tokens,
        obtainedAt: _obtainedAt,
        lost: _lost,
        problem: _problem,
        ...kept
      } = current.record
      return { url: current.url, grant: current.grant + 1, record: kept }
    })
  )
  revokeBotToolSignIns(old ? [old] : [])
}

const revocations = new Set<Promise<void>>()

/** Ends removed sign-ins with their apps, in the background; the local copies are already gone. */
export function revokeBotToolSignIns(entries: readonly BotToolOAuthEntry[]): void {
  for (const entry of entries) {
    if (entry.record.tokens) {
      void revokeTokens(entry.url, entry.record)
    }
  }
}

/** Settles once every revocation started so far has; for tests and shutdown. */
export async function settleBotToolRevocations(): Promise<void> {
  while (revocations.size > 0) {
    await Promise.all(revocations)
  }
}

export function revokeTokens(url: string, record: BotToolOAuthRecord): Promise<void> {
  const run = revokeNow(url, record).catch(() => undefined)
  const tracked = run.finally(() => revocations.delete(tracked))
  revocations.add(tracked)
  return tracked
}

/** RFC 7009, refresh token first: most servers end the access token with its grant. */
async function revokeNow(url: string, record: BotToolOAuthRecord): Promise<void> {
  const { issuer, client, tokens } = record
  if (!issuer || !client || !tokens) {
    return
  }
  const origin = new URL(issuer).origin
  const fetchFn = fetchFor(url, AbortSignal.timeout(REVOKE_DEADLINE_MS * 3))
  let metadata: AuthorizationServerMetadata | undefined
  try {
    metadata = await issuerMetadata(issuer, fetchFn)
  } catch {
    console.warn(`[bot-tool-oauth] revoke ${origin}: metadata unreadable`)
    return
  }
  const endpoint = metadata ? extra(metadata).revocation_endpoint : undefined
  if (!endpoint) {
    // The app offers no revocation; its tokens end when they expire.
    return
  }
  const methods =
    (metadata ? extra(metadata).revocation_endpoint_auth_methods_supported : undefined) ??
    metadata?.token_endpoint_auth_methods_supported ??
    []
  const secret = typeof client.client_secret === 'string' ? client.client_secret : undefined
  for (const [token, hint] of [
    [tokens.refresh_token, 'refresh_token'],
    [tokens.access_token, 'access_token']
  ] as const) {
    if (!token) {
      continue
    }
    const body = new URLSearchParams({ token, token_type_hint: hint })
    const headers = new Headers({
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    })
    if (secret && (methods.includes('client_secret_basic') || methods.length === 0)) {
      const basic = Buffer.from(
        `${encodeURIComponent(client.client_id)}:${encodeURIComponent(secret)}`
      ).toString('base64')
      headers.set('authorization', `Basic ${basic}`)
    } else {
      body.set('client_id', client.client_id)
      if (secret && methods.includes('client_secret_post')) {
        body.set('client_secret', secret)
      }
    }
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REVOKE_DEADLINE_MS)
      })
      if (!response.ok) {
        console.warn(`[bot-tool-oauth] revoke ${origin} ${hint}: HTTP ${response.status}`)
      }
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'unknown'
      console.warn(`[bot-tool-oauth] revoke ${origin} ${hint}: ${kind}`)
    }
  }
}
