// A sign-in's access token: refreshed silently (never a browser, never a registration), once per
// credential at a time, and committed only over the revision it started from.
import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { BotToolSignInStatus } from '../../../shared/bot-tool-sign-in'
import {
  commitBotToolOAuth,
  readBotToolOAuth,
  type BotToolOAuthEntry
} from '../bot-tool-credentials'
import {
  TOKEN_DEADLINE_MS,
  expiring,
  fetchFor,
  inTransaction,
  keyOf,
  now,
  type BotToolGrant,
  type BotToolOAuthKey
} from './bot-tool-oauth'
import { revokeTokens } from './bot-tool-oauth-revoke'
import { issuerMetadata } from './bot-tool-oauth-discovery'

const refreshes = new Map<string, Promise<void>>()

/**
 * Waits for `work` and settles as it does, or stops waiting when `signal` aborts; never cancels
 * `work` for the others waiting on it.
 */
function waitFor(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return work
  }
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error('aborted'))
    if (signal.aborted) {
      stop()
      return
    }
    signal.addEventListener('abort', stop, { once: true })
    work.then(
      () => {
        signal.removeEventListener('abort', stop)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      }
    )
  })
}

/** One refresh per credential at a time, whoever asks; a rotated refresh token is spent once. */
function refreshShared(key: BotToolOAuthKey): Promise<void> {
  const id = keyOf(key)
  let running = refreshes.get(id)
  if (!running) {
    running = refreshOnce(key).finally(() => {
      if (refreshes.get(id) === running) {
        refreshes.delete(id)
      }
    })
    refreshes.set(id, running)
    // Every waiter may have stopped waiting; a failure is theirs to see, never an unhandled one.
    running.catch(() => undefined)
  }
  return running
}

async function refreshOnce(key: BotToolOAuthKey): Promise<void> {
  const entry = readBotToolOAuth(key.folder, key.credentialId)
  const record = entry?.record
  const refreshToken = record?.tokens?.refresh_token
  if (!entry || !record?.issuer || !record.client || !refreshToken) {
    return
  }
  const issuer = record.issuer
  const fetchFn = fetchFor(entry.url, AbortSignal.timeout(TOKEN_DEADLINE_MS))
  let tokens: OAuthTokens
  try {
    const metadata = await issuerMetadata(issuer, fetchFn)
    if (!metadata) {
      // No metadata naming this issuer: its endpoints can't be trusted with the refresh token.
      return
    }
    tokens = await refreshAuthorization(issuer, {
      metadata,
      clientInformation: record.client,
      refreshToken,
      resource: record.resource,
      fetchFn
    })
  } catch (error) {
    const lost =
      error instanceof InvalidClientError || error instanceof UnauthorizedClientError
        ? 'client'
        : error instanceof InvalidGrantError
          ? 'grant'
          : null
    // A timeout, network failure or server error keeps the sign-in for the next try.
    if (lost) {
      await inTransaction(key, () =>
        commitBotToolOAuth(key.folder, key.credentialId, (current) => {
          // The refusal was about the refresh token this run spent, nothing committed since.
          if (current?.revision !== entry.revision) {
            return undefined
          }
          const { tokens: _tokens, obtainedAt: _obtainedAt, client, ...kept } = current.record
          return {
            url: current.url,
            grant: current.grant,
            record: { ...kept, ...(lost === 'grant' && client ? { client } : {}), lost }
          }
        })
      )
    }
    return
  }
  let gone = false
  const committed = await inTransaction(key, () =>
    commitBotToolOAuth(key.folder, key.credentialId, (current) => {
      // Revoked only when no sign-in on the same client stands: some servers end every grant a
      // client has for a user on one revocation, which would end that sign-in too.
      gone =
        !current ||
        current.url !== entry.url ||
        (current.grant !== entry.grant &&
          (!current.record.tokens || current.record.client?.client_id !== record.client?.client_id))
      return current?.revision === entry.revision
        ? {
            url: current.url,
            grant: current.grant,
            record: { ...current.record, tokens, obtainedAt: now() }
          }
        : undefined
    })
  )
  if (!committed && gone) {
    // Removed or signed out while this ran: what it earned must not outlive that.
    void revokeTokens(entry.url, { ...record, tokens })
  }
}

function usable(entry: BotToolOAuthEntry | null): BotToolGrant | null {
  const tokens = entry?.record.tokens
  return entry && tokens && !expiring(entry.record, 0)
    ? { token: tokens.access_token, grant: entry.grant }
    : null
}

/**
 * The token to send now, refreshed first when it's about to expire; null when there is no sign-in
 * a call could use. Never opens a browser and never registers. `entry`: the sign-in just read.
 */
export async function botToolAccessToken(
  key: BotToolOAuthKey,
  signal?: AbortSignal,
  entry = readBotToolOAuth(key.folder, key.credentialId)
): Promise<BotToolGrant | null> {
  if (!entry?.record.tokens) {
    return null
  }
  if (expiring(entry.record) && entry.record.tokens.refresh_token) {
    await waitFor(refreshShared(key), signal)
    return usable(readBotToolOAuth(key.folder, key.credentialId))
  }
  // An expired token with nothing to renew it goes as it is: the app's refusal ends the sign-in.
  return { token: entry.record.tokens.access_token, grant: entry.grant }
}

/**
 * A new token after the app refused `rejected`, or null when the sign-in can't go on. Calls that
 * were refused together share one refresh; one that arrives after it reads the new token.
 */
export async function refreshBotToolAccessToken(
  key: BotToolOAuthKey,
  rejected: string,
  signal?: AbortSignal,
  entry = readBotToolOAuth(key.folder, key.credentialId)
): Promise<BotToolGrant | null> {
  const tokens = entry?.record.tokens
  if (!entry || !tokens) {
    return null
  }
  if (tokens.access_token !== rejected) {
    return { token: tokens.access_token, grant: entry.grant }
  }
  if (!tokens.refresh_token) {
    // Nothing to renew it with: the app said it's over, so the row asks for a new sign-in.
    await inTransaction(key, () =>
      commitBotToolOAuth(key.folder, key.credentialId, (current) => {
        if (current?.revision !== entry.revision) {
          return undefined
        }
        const { tokens: _tokens, obtainedAt: _obtainedAt, ...kept } = current.record
        return { url: current.url, grant: current.grant, record: { ...kept, lost: 'grant' } }
      })
    )
    return null
  }
  await waitFor(refreshShared(key), signal)
  const next = readBotToolOAuth(key.folder, key.credentialId)
  const token = next?.record.tokens?.access_token
  return next && token && token !== rejected ? { token, grant: next.grant } : null
}

// ---------------------------------------------------------------------------------------------
// State, sign-out, removal

/** The row's state, from the store alone; null when the tool isn't one Orca signs in to. */
export function botToolSignInState(key: BotToolOAuthKey): BotToolSignInStatus | null {
  return botToolSignInStatusOf(readBotToolOAuth(key.folder, key.credentialId))
}

/** `botToolSignInState` for a sign-in already read. */
export function botToolSignInStatusOf(entry: BotToolOAuthEntry | null): BotToolSignInStatus | null {
  if (!entry) {
    return null
  }
  const { tokens, lost, problem } = entry.record
  const shown = problem ? { problem } : {}
  if (tokens) {
    if (!tokens.refresh_token && expiring(entry.record, 0)) {
      return { state: 'lost', ...shown }
    }
    return { state: 'signed-in', limited: !tokens.refresh_token }
  }
  return lost ? { state: 'lost', ...shown } : { state: 'signed-out', ...shown }
}
