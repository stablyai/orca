import type {
  OrcaProfileCloudSummary,
  OrcaProfileListState
} from '../../../shared/orca-profiles/orca-profiles'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import { revokeOrcaCloudSession } from '../cloud-auth/profile-cloud-client'
import {
  cloudConnectLinkEpoch,
  isCloudConnectAttemptSuperseded,
  markCloudConnectAttemptLinked
} from '../cloud-auth/profile-cloud-connect-attempts'
import { linkOrcaProfileToCloud } from '../cloud-auth/profile-cloud-index'
import { loadOrCreateProfileIndex, readProfileIndex } from '../profile-index-store'
import { getOrcaProfileIndexPath } from '../profile-storage-paths'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import type { OrcaCloudSession, OrcaCloudSessionReadResult } from './profile-cloud-session-store'
import {
  readCloudSession,
  restoreCloudSession,
  sessionFromExchange,
  signInCloudSession
} from './profile-cloud-session-owner'

export type CloudAccountTransition = {
  /** The profile receiving the account, captured when the sign-in started. */
  profileId: string
  nextUserId: string
  /** The profile's account before the change; null when it has none. */
  currentUserId: string | null
}

export type CloudSessionCommitGuards = {
  /** Aborted when the person cancels; checked after the exchange, before anything is saved. */
  signal?: AbortSignal
  /** Refuse memory-only and plaintext saves instead of falling back to them. */
  requireSealedStorage?: boolean
  /** A reason this account may not replace the current one (for example, links it does not own). */
  mayCommit?: (transition: CloudAccountTransition) => string | null
  /** The link epoch when the sign-in began; a sign-out or another sign-in since then cancels it. */
  expectedLinkEpoch?: number
}

export type CloudSessionCommitOutcome =
  | { status: 'committed'; list: OrcaProfileListState }
  | { status: 'cancelled' }
  | { status: 'refused'; error: string }

type CommitArgs = {
  config: OrcaCloudAuthConfig
  profileId: string
  userDataPath: string
  attempt: number
  exchange: OrcaCloudSessionExchangeResponse
  guards?: CloudSessionCommitGuards
}

/** Installs an exchanged session as the profile's account in one recoverable step: on any failure
 * the previous session stays (or is put back) and the unused new one is revoked. */
export async function commitExchangedCloudSession(
  args: CommitArgs
): Promise<CloudSessionCommitOutcome> {
  let outcome: CloudSessionCommitOutcome | undefined
  try {
    outcome = installExchangedSession(args)
    return outcome
  } catch (error) {
    return { status: 'refused', error: errorMessage(error) }
  } finally {
    if (outcome?.status !== 'committed') {
      revokeInBackground(args.config, sessionFromExchange(args.exchange))
    }
  }
}

function installExchangedSession(args: CommitArgs): CloudSessionCommitOutcome {
  const { config, profileId, userDataPath, attempt, exchange, guards = {} } = args
  if (
    isCloudConnectAttemptSuperseded(attempt) ||
    guards.signal?.aborted ||
    (guards.expectedLinkEpoch !== undefined && cloudConnectLinkEpoch() !== guards.expectedLinkEpoch)
  ) {
    return { status: 'cancelled' }
  }
  const previousCloud = profileCloud(profileId, userDataPath)
  const refusal = guards.mayCommit?.({
    profileId,
    nextUserId: exchange.cloud.userId,
    currentUserId: previousCloud?.userId ?? null
  })
  if (refusal) {
    return { status: 'refused', error: refusal }
  }
  const replaced = readCloudSession(profileId, userDataPath)
  const previous = attributed(replaced, previousCloud)
  signInCloudSession(profileId, userDataPath, exchange, {
    requireSealed: guards.requireSealedStorage
  })
  let list: OrcaProfileListState
  try {
    list = linkOrcaProfileToCloud(profileId, exchange.cloud, userDataPath)
  } catch (error) {
    const published = readPublishedList(profileId, userDataPath, exchange.cloud)
    if (!published) {
      restoreCloudSession(profileId, userDataPath, previous)
      throw error
    }
    // The index already names the new account, so finish the change; the artifact cleanup marker
    // keeps artifacts fenced until a later link completes it.
    console.warn('[orca-account] Account change finished with its cleanup pending')
    list = published
  }
  markCloudConnectAttemptLinked(attempt)
  if (replaced.status === 'found' && replaced.session.refreshToken !== exchange.refreshToken) {
    revokeInBackground(config, replaced.session)
  }
  return { status: 'committed', list }
}

function profileCloud(
  profileId: string,
  userDataPath: string
): OrcaProfileCloudSummary | undefined {
  const profile = loadOrCreateProfileIndex(userDataPath).profiles.find((p) => p.id === profileId)
  if (!profile) {
    throw new Error('unknown_orca_profile')
  }
  return profile.cloud
}

// A restored session must carry the identity it had, or a later reader could take it for the new
// account's; one nobody can attribute is not restored.
function attributed(
  previous: OrcaCloudSessionReadResult,
  cloud: OrcaProfileCloudSummary | undefined
): OrcaCloudSessionReadResult {
  if (previous.status !== 'found' || previous.session.identity) {
    return previous
  }
  if (!cloud) {
    return { status: 'missing', persistence: 'none' }
  }
  const identity = { userId: cloud.userId, cloudProfileId: cloud.cloudProfileId }
  return { ...previous, session: { ...previous.session, identity } }
}

function readPublishedList(
  profileId: string,
  userDataPath: string,
  cloud: OrcaProfileCloudSummary
): OrcaProfileListState | null {
  try {
    const index = readProfileIndex(getOrcaProfileIndexPath(userDataPath))
    const linked = index?.profiles.find((profile) => profile.id === profileId)?.cloud
    return index &&
      linked?.userId === cloud.userId &&
      linked.cloudProfileId === cloud.cloudProfileId
      ? { activeProfileId: index.activeProfileId, profiles: index.profiles }
      : null
  } catch {
    return null
  }
}

// Best effort: a session nobody keeps should not stay live in the cloud's machine list.
function revokeInBackground(config: OrcaCloudAuthConfig, session: OrcaCloudSession): void {
  void Promise.resolve()
    .then(() => revokeOrcaCloudSession(config, session))
    .catch(() => console.warn('[orca-account] Could not revoke an unused sign-in'))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
