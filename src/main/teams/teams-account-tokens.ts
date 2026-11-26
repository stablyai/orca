// Keeps the Teams sign-in's access token fresh on this host through the same host login refresh
// Google and Linear use. A grant Microsoft ended moves the account to Reconnect.
import { createHostOAuthRefresher, type HostOAuthRefresher } from '../host-oauth/host-oauth-refresh'
import {
  readTeamsAccount,
  saveTeamsAccount,
  type TeamsAccountRecord
} from './teams-credential-store'
import { teamsTokenUrl, type TeamsHttp } from './teams-device-sign-in'
import { teamsSignInScopes } from './teams-scopes'

export type TeamsTokenDeps = { http: TeamsHttp; now: () => number }

const RECONNECT =
  'Microsoft ended this sign-in (revoked, expired, or a policy changed). Run `orca teams connect` again.'

export class TeamsNotConnectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamsNotConnectedError'
  }
}

// One refresher per tenant: a single-tenant app refreshes only at its own tenant's endpoint.
const refreshers = new Map<string, HostOAuthRefresher>()

function refresherFor(tenantId: string): HostOAuthRefresher {
  let refresher = refreshers.get(tenantId)
  if (!refresher) {
    refresher = createHostOAuthRefresher<TeamsAccountRecord>({
      tokenUrl: teamsTokenUrl(tenantId),
      refreshAheadMs: 5 * 60_000,
      rotates: false,
      // Not invalid_client or unauthorized_client: an admin fixes those in the app or tenant settings,
      // and the grant may still work after.
      endedErrors: ['interaction_required'],
      read: () => readTeamsAccount(),
      grantOf: (record) =>
        record.status === 'connected' && record.refreshToken && record.tenantId === tenantId
          ? {
              refreshToken: record.refreshToken,
              expiresAt: record.accessToken ? record.expiresAt : 0,
              clientId: record.clientId,
              scope: teamsSignInScopes(record.channels).join(' ')
            }
          : null,
      save: (_id, record, refreshed) =>
        saveTeamsAccount(
          {
            ...record,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            ...(refreshed.scope ? { grantedScopes: refreshed.scope.split(' ') } : {})
          },
          { expectedRefreshToken: record.refreshToken ?? undefined }
        ),
      ended: (_id, record) =>
        saveTeamsAccount(
          {
            ...record,
            status: 'reconnect',
            reason: RECONNECT,
            refreshToken: null,
            accessToken: null
          },
          { expectedRefreshToken: record.refreshToken ?? undefined }
        )
    })
    refreshers.set(tenantId, refresher)
  }
  return refresher
}

/** The connected account with a usable access token; `force` renews one Graph refused. */
export async function teamsAccount(
  deps: TeamsTokenDeps,
  force = false
): Promise<TeamsAccountRecord & { accessToken: string }> {
  const saved = await readTeamsAccount()
  if (!saved) {
    throw new TeamsNotConnectedError(
      'Microsoft Teams is not connected on this computer. Your owner connects it with `orca teams connect`.'
    )
  }
  const outcome = await refresherFor(saved.tenantId).refresh(
    'teams',
    { now: deps.now, request: deps.http },
    force
  )
  const record = await readTeamsAccount()
  if (!record || record.status !== 'connected' || !record.accessToken) {
    throw new TeamsNotConnectedError(record?.reason ?? RECONNECT)
  }
  if (outcome === 'offline' && record.expiresAt <= deps.now()) {
    throw new TeamsNotConnectedError(
      "Couldn't renew the Teams sign-in: Microsoft didn't answer, or refused the app (check that its Entra app still allows public client flows). Try again in a moment."
    )
  }
  return { ...record, accessToken: record.accessToken }
}
