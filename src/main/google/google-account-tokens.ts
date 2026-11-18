// Keeps each Google account's access token fresh on this host (Google's last an hour), with no Orca
// Cloud involvement, through the same host login refresh Linear uses. Google's refresh needs the
// client secret, so each saved account keeps its own. A grant Google ended moves the account to
// Reconnect instead of failing each call.
import { createHostOAuthRefresher } from '../host-oauth/host-oauth-refresh'
import {
  readGoogleAccount,
  saveGoogleAccount,
  type GoogleAccountRecord
} from './google-credential-store'
import { defaultGoogleHttp, GOOGLE_TOKEN_URL, type GoogleHttp } from './google-token-endpoint'

export type GoogleTokenDeps = { http: GoogleHttp; now: () => number }
export const defaultGoogleTokenDeps: GoogleTokenDeps = { http: defaultGoogleHttp, now: Date.now }

// The grant is gone: revoked, expired (an unpublished External app's 7 days), or its client deleted.
const GRANT_ENDED: Record<string, string> = {
  invalid_grant: 'Google access ended (revoked, expired, or the password changed). Reconnect.',
  invalid_client:
    'The Google client this account signed in with was deleted or changed. Reconnect.',
  unauthorized_client:
    'The Google client this account signed in with was deleted or changed. Reconnect.'
}

export class GoogleAccountUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleAccountUnavailableError'
  }
}

/** Keeps the account listed (and every bot toggle) but drops tokens Google no longer honours. */
export function markGoogleAccountReconnect(
  record: GoogleAccountRecord,
  reason: string
): GoogleAccountRecord {
  return { ...record, status: 'reconnect', reason, refreshToken: null, accessToken: null }
}

// Keyed by lower-case email, so two spellings of one account share a refresh.
const refresher = createHostOAuthRefresher<GoogleAccountRecord>({
  tokenUrl: GOOGLE_TOKEN_URL,
  refreshAheadMs: 5 * 60_000,
  rotates: false,
  endedErrors: Object.keys(GRANT_ENDED),
  read: readGoogleAccount,
  grantOf: (record) =>
    record.status === 'connected' && record.refreshToken
      ? {
          refreshToken: record.refreshToken,
          // No access token yet reads as due.
          expiresAt: record.accessToken ? record.expiresAt : 0,
          clientId: record.client.clientId,
          clientSecret: record.client.clientSecret
        }
      : null,
  save: (_email, record, refreshed) =>
    saveGoogleAccount({
      ...record,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      ...(refreshed.scope ? { grantedScopes: refreshed.scope.split(' ') } : {})
    }),
  ended: (_email, record, error) =>
    saveGoogleAccount(
      markGoogleAccountReconnect(record, GRANT_ENDED[error] ?? GRANT_ENDED.invalid_grant)
    )
})

/** The account after refreshing it when due (or now, when Google refused its token: force). */
export async function refreshGoogleAccount(
  email: string,
  deps: GoogleTokenDeps = defaultGoogleTokenDeps,
  force = false
): Promise<GoogleAccountRecord> {
  const key = email.toLowerCase()
  const outcome = await refresher.refresh(key, { now: deps.now, request: deps.http }, force)
  const record = readGoogleAccount(key)
  if (!record) {
    throw new GoogleAccountUnavailableError(
      `${email} isn't connected on this computer. Connect it in Orca.`
    )
  }
  if (outcome === 'offline' && (!record.accessToken || record.expiresAt <= deps.now())) {
    throw new GoogleAccountUnavailableError(
      `Couldn't reach Google to renew ${email}'s sign-in. Try again in a moment.`
    )
  }
  return record
}

/** A usable access token for the account, refreshed first when it is near its end. */
export async function googleAccessToken(
  email: string,
  deps: GoogleTokenDeps = defaultGoogleTokenDeps
): Promise<string> {
  const record = await refreshGoogleAccount(email, deps)
  if (record.status !== 'connected' || !record.accessToken) {
    throw new GoogleAccountUnavailableError(
      `${record.reason ?? 'Google access ended.'} Reconnect it in Orca.`
    )
  }
  return record.accessToken
}
