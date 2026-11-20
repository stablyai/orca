// Connector tokens for the desktop's signed-in Orca account, fetched the way relay tokens are.
import { z } from 'zod'
import type { OrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-store'
import {
  readFreshOrcaCloudSession,
  refreshAfterRejectedAccessToken
} from '../orca-profiles/cloud-session/profile-cloud-session-refresh'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { loadOrCreateHostInstallationId } from '../runtime/hosts/platform-probe/host-descriptor'
import {
  requestConnector,
  SIGNED_OUT,
  UNREADABLE_ANSWER,
  type ConnectorResult
} from './connector-cloud-request'
import {
  connectorHostKeyResetPending,
  loadOrCreateConnectorHostKey,
  setConnectorHostKeyResetPending,
  signConnectorHostProof,
  type ConnectorHostKey
} from './connector-host-key'
import type { ConnectorToken, ConnectorTokenMint } from './connector-transport'

// The auth service's flag for accepting a host-key proof; servers without it refuse the field.
export const CONNECTOR_HOST_KEY_CAPABILITY = 'connector.hostKey'

const ConnectorTokenResponse = z.object({
  connectorToken: z
    .string()
    .min(1)
    .max(8 * 1024),
  expiresAt: z.number().int().positive()
})

// Refusals a fresh session can't change, whatever their status, so they never refresh it.
const NO_REFRESH_REFUSALS: ReadonlySet<string> = new Set([
  'host_proof_required',
  'host_proof_invalid',
  'host_proof_stale',
  'host_proof_replayed',
  'host_key_limit',
  'host_key_mismatch',
  'recent_sign_in_required'
])
// This key is not the one the cloud holds for the install; only a fresh sign-in may replace it.
const HOST_KEY_REFUSALS: ReadonlySet<string> = new Set([
  'host_key_mismatch',
  'recent_sign_in_required'
])
const ServerTime = z.object({ serverTime: z.number().int().positive() })

// The server clock minus ours, learned from a stale-proof refusal.
let clockOffsetMs = 0

async function hostKeyOrNull(userDataPath: string): Promise<ConnectorHostKey | null> {
  try {
    return await loadOrCreateConnectorHostKey(userDataPath)
  } catch (error) {
    // Without a key the mint still works until the cloud requires a proof.
    console.warn('[connector] host key unavailable:', error)
    return null
  }
}

/** Reads the server's clock off a refusal, leaving the body for the request to read. */
function withServerTime(fetchImpl: typeof globalThis.fetch): {
  fetchImpl: typeof globalThis.fetch
  serverTime: () => number | null
} {
  let serverTime: number | null = null
  return {
    serverTime: () => serverTime,
    fetchImpl: async (input, init) => {
      const response = await fetchImpl(input, init)
      serverTime = null
      if (response.status === 403) {
        const parsed = ServerTime.safeParse(
          await response
            .clone()
            .json()
            .catch(() => null)
        )
        serverTime = parsed.success ? parsed.data.serverTime : null
      }
      return response
    }
  }
}

/** The account the connector serves, read like the relay's: the active profile's cloud user. */
export function connectorAccount(userDataPath: string): string | null {
  return ensureActiveOrcaProfile(userDataPath).profile.cloud?.userId ?? null
}

/** That account's name as people see it, as a mirrored Slack post names its author. */
export function connectorAccountName(userDataPath: string): string {
  const cloud = ensureActiveOrcaProfile(userDataPath).profile.cloud
  return cloud?.displayName?.trim() || cloud?.email.split('@')[0] || ''
}

/**
 * Mints only for `account`; after a switch or sign-out the old client gets no token for the new one.
 * No answer from the connector-token route ever clears the Orca session: a refusal comes back as is.
 */
export function desktopConnectorTokenMint(
  authConfig: OrcaCloudAuthConfig,
  userDataPath: string,
  account: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): ConnectorTokenMint {
  return async () => {
    if (connectorAccount(userDataPath) !== account) {
      return SIGNED_OUT
    }
    const active = ensureActiveOrcaProfile(userDataPath)
    try {
      // Only a refresh the auth service itself refuses can sign out here, as for any Orca Cloud call.
      const fresh = await readFreshOrcaCloudSession(authConfig, active, userDataPath)
      if (fresh.status !== 'found') {
        return SIGNED_OUT
      }
      const mint = (session: OrcaCloudSession) =>
        mintConnectorToken(authConfig, userDataPath, account, fetchImpl, session)
      let answer = await mint(fresh.session)
      let refreshedNow = false
      if (sessionMayLiftRefusal(answer)) {
        // The app's calls share this budget, so together they rotate at most once per backoff.
        const refreshed = await refreshAfterRejectedAccessToken(
          authConfig,
          active,
          userDataPath,
          fresh.session
        )
        if (refreshed.status === 'reconnect-required') {
          return SIGNED_OUT
        }
        if (refreshed.status === 'found') {
          refreshedNow = true
          answer = await mint(refreshed.session)
        }
      }
      if (connectorAccount(userDataPath) !== account) {
        return SIGNED_OUT
      }
      // A skipped refresh (the slot is spent, maybe by a failed one) proves nothing about the sign-in.
      return refreshedNow && sessionMayLiftRefusal(answer) && !answer.ok
        ? { ...answer, sessionRefused: true }
        : answer
    } catch {
      return UNREADABLE_ANSWER
    }
  }
}

/** A 401 no code explains: only an expired access token is worth a fresh session; a 403 never is. */
function sessionMayLiftRefusal(answer: ConnectorResult<ConnectorToken>): boolean {
  return !answer.ok && answer.status === 401 && !NO_REFRESH_REFUSALS.has(answer.error ?? '')
}

async function mintConnectorToken(
  authConfig: OrcaCloudAuthConfig,
  userDataPath: string,
  account: string,
  fetchImpl: typeof globalThis.fetch,
  session: OrcaCloudSession
): Promise<ConnectorResult<ConnectorToken>> {
  // The per-install id the host descriptor already keeps; the cloud keys this machine on it.
  const machineId = await loadOrCreateHostInstallationId(userDataPath)
  const reset = await connectorHostKeyResetPending(userDataPath, account)
  const timed = withServerTime(fetchImpl)
  const mint = (hostKey: ConnectorHostKey | null) =>
    requestConnector(
      {
        fetchImpl: timed.fetchImpl,
        url: authConfig.connectorTokenEndpoint,
        body: hostKey
          ? {
              machineId,
              hostKey: signConnectorHostProof(hostKey, {
                userId: account,
                machineId,
                signedAt: Date.now() + clockOffsetMs,
                reset
              })
            }
          : { machineId },
        token: session.accessToken
      },
      ConnectorTokenResponse
    )
  // Only a server that advertises the proof accepts it; older ones answer 400 to the field.
  let hostKey =
    session.capabilities.flags[CONNECTOR_HOST_KEY_CAPABILITY] === true
      ? await hostKeyOrNull(userDataPath)
      : null
  let answer = await mint(hostKey)
  // Capabilities older than the server's enforcement: prove once and keep going.
  if (!answer.ok && answer.error === 'host_proof_required' && !hostKey) {
    hostKey = await hostKeyOrNull(userDataPath)
    if (hostKey) {
      answer = await mint(hostKey)
    }
  }
  const serverTime = timed.serverTime()
  if (hostKey && !answer.ok && answer.error === 'host_proof_stale' && serverTime !== null) {
    clockOffsetMs = serverTime - Date.now()
    answer = await mint(hostKey)
  }
  if (hostKey && answer.ok && reset) {
    await setConnectorHostKeyResetPending(userDataPath, account, false)
  }
  if (!answer.ok && answer.error && HOST_KEY_REFUSALS.has(answer.error)) {
    await setConnectorHostKeyResetPending(userDataPath, account, true)
  }
  return answer
}
