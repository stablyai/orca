// Keeps each Google account's access token fresh on this host (Google's last an hour), with no Orca
// Cloud involvement, through the same host login refresh Linear uses. Google's refresh needs the
// client secret, so each saved account keeps its own. A grant Google ended moves the account to
// Reconnect instead of failing each call.
import { createHostOAuthRefresher, type HostOAuthRefusal } from '../host-oauth/host-oauth-refresh'
import {
  readGoogleAccount,
  saveGoogleAccount,
  type GoogleAccountRecord
} from './google-credential-store'
import { defaultGoogleHttp, GOOGLE_TOKEN_URL, type GoogleHttp } from './google-token-endpoint'

export type GoogleTokenDeps = { http: GoogleHttp; now: () => number }
export const defaultGoogleTokenDeps: GoogleTokenDeps = { http: defaultGoogleHttp, now: Date.now }

const CLIENT_GONE = 'The Google client this account signed in with was deleted or changed.'
// Refusals a retry can't fix, from Google's OAuth error list: revoked or expired (an unpublished
// External app's 7 days), the client deleted, an admin policy, or an account outside an internal
// app's organization. Anything else (5xx, rate limits, an unreachable network) stays temporary.
const GRANT_ENDED: Record<string, string> = {
  invalid_grant: 'Google access ended (revoked, expired, or the password changed).',
  invalid_client: CLIENT_GONE,
  unauthorized_client: CLIENT_GONE,
  deleted_client: CLIENT_GONE,
  admin_policy_enforced: "Your Google Workspace admin's policy blocked Orca's access.",
  org_internal: "This account isn't in the organization the Google client is limited to."
}

/** Google's refusal as one line: its description, then its code and subtype. */
export function googleRefusalText(refusal: HostOAuthRefusal): string {
  const code = [refusal.error, refusal.subtype].filter(Boolean).join(', ')
  return refusal.description ? `${refusal.description} (${code})` : code
}

export class GoogleAccountUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleAccountUnavailableError'
  }
}

/** Keeps the account listed (and every bot toggle) but drops tokens Google no longer honours. */
function markGoogleAccountReconnect(
  record: GoogleAccountRecord,
  refusal: HostOAuthRefusal
): GoogleAccountRecord {
  return {
    ...record,
    status: 'reconnect',
    reason: GRANT_ENDED[refusal.error] ?? GRANT_ENDED.invalid_grant,
    googleError: refusal,
    refreshToken: null,
    accessToken: null
  }
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
    saveGoogleAccount(
      {
        ...record,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        ...(refreshed.scope ? { grantedScopes: refreshed.scope.split(' ') } : {})
      },
      record.refreshToken ?? undefined
    ),
  ended: (_email, record, refusal) =>
    saveGoogleAccount(markGoogleAccountReconnect(record, refusal), record.refreshToken ?? undefined)
})

/** The account after refreshing it when due (or now, when Google refused its token: force). */
export async function refreshGoogleAccount(
  email: string,
  deps: GoogleTokenDeps = defaultGoogleTokenDeps,
  force = false
): Promise<GoogleAccountRecord> {
  const key = email.toLowerCase()
  const outcome = await refresher.refresh(key, { now: deps.now, request: deps.http }, force)
  const record = await readGoogleAccount(key)
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
      `${record.reason ?? 'Google access ended.'} Reconnect ${record.email} in Orca.`
    )
  }
  return record.accessToken
}
