import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import type { ActiveOrcaProfileState } from './profile-index-store'
import { orcaCloudSessionKey, type OrcaCloudSession } from './profile-cloud-session-store'
import {
  isAmbiguousCloudRequestFailure,
  OrcaCloudRequestError,
  refreshOrcaCloudSession
} from './profile-cloud-client'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  AMBIGUOUS_REFRESH_REPLAY_DELAY_MS,
  AmbiguousRefreshReplayBlockedError,
  blocksAmbiguousRefreshReplay,
  forgetAmbiguousRefreshAttempt,
  recordAmbiguousRefreshAttempt,
  wasRefreshTokenAmbiguouslyAttempted
} from './profile-cloud-refresh-replay-guard'
import { emitOrcaCloudSessionInvalidated } from './profile-cloud-session-invalidation'
import {
  commitCloudSessionRotation,
  readCloudSession,
  signOutRevokedCloudSession,
  takeCloudSessionTicket
} from './profile-cloud-session-owner'

const CLOUD_SESSION_REFRESH_SKEW_MS = 60_000

export type FreshCloudSessionResult =
  | { status: 'found'; session: OrcaCloudSession }
  | { status: 'reconnect-required' }

export type CloudSessionOperationResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }

function shouldRefreshCloudSession(session: OrcaCloudSession, now = Date.now()): boolean {
  return session.expiresAt <= now + CLOUD_SESSION_REFRESH_SKEW_MS
}

// A 403 is a permission answer, never an expired token, so only a 401 may force a refresh.
function isAccessTokenRejected(error: unknown): boolean {
  return error instanceof OrcaCloudRequestError && error.statusCode === 401
}

// An operation that keeps answering 401 must not rotate the token on every call.
const FORCED_REFRESH_BACKOFF_MS = 5 * 60_000
const lastForcedRefreshAt = new Map<string, number>()

function takeForcedRefreshSlot(key: string, now = Date.now()): boolean {
  const last = lastForcedRefreshAt.get(key)
  // A clock rollback must not stretch the backoff.
  if (last !== undefined && now >= last && now - last < FORCED_REFRESH_BACKOFF_MS) {
    return false
  }
  lastForcedRefreshAt.set(key, now)
  return true
}

// Only the auth server's own verdict may discard a sign-in; proxies, outages and limits never do.
function isRefreshTokenRejected(error: unknown): boolean {
  return (
    error instanceof OrcaCloudRequestError &&
    error.statusCode === 401 &&
    error.errorCode === 'invalid_refresh_token'
  )
}

const inflightCloudSessionRefreshes = new Map<string, Promise<OrcaCloudSession>>()

class StaleCloudSessionMutationError extends Error {
  constructor() {
    super('stale_cloud_session_mutation')
  }
}

function clearCloudSessionIfUnchanged(
  profileId: string,
  userDataPath: string,
  failed: OrcaCloudSession
): void {
  if (!signOutRevokedCloudSession(profileId, userDataPath, failed)) {
    return
  }
  forgetAmbiguousRefreshAttempt(orcaCloudSessionKey(profileId, userDataPath))
  // Invalidate the renderer’s cached Connected state immediately.
  emitOrcaCloudSessionInvalidated()
}

// Distinguish genuine revocation from ambiguous refresh replay without logging tokens.
function warnIfPossibleRefreshReplay(
  profileId: string,
  userDataPath: string,
  failed: OrcaCloudSession
): void {
  const key = orcaCloudSessionKey(profileId, userDataPath)
  if (!wasRefreshTokenAmbiguouslyAttempted(key, failed.refreshToken)) {
    return
  }
  console.warn(
    '[orca-cloud] orca_cloud_refresh_possible_replay: refresh rejected 401 for a token whose earlier attempt never answered'
  )
}

type CloudSessionRefreshAttempt =
  | { status: 'refreshed'; response: OrcaCloudSessionExchangeResponse }
  | { status: 'rotated-elsewhere'; session: OrcaCloudSession }

function isRetryableCloudRefreshRejection(error: unknown): boolean {
  return error instanceof OrcaCloudRequestError && error.statusCode >= 500
}

async function attemptCloudSessionRefresh(
  key: string,
  config: OrcaCloudAuthConfig,
  active: ActiveOrcaProfileState,
  userDataPath: string,
  session: OrcaCloudSession
): Promise<CloudSessionRefreshAttempt> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await refreshOrcaCloudSession(config, session)
      forgetAmbiguousRefreshAttempt(key)
      return { status: 'refreshed', response }
    } catch (error) {
      const ambiguous = isAmbiguousCloudRequestFailure(error)
      if (ambiguous) {
        recordAmbiguousRefreshAttempt(key, session.refreshToken)
      }
      if (attempt > 0 || (!ambiguous && !isRetryableCloudRefreshRejection(error))) {
        throw error
      }
      // An unanswered attempt may have rotated the token; replay it once while the server's
      // rotation grace still returns the successor, instead of after the grace treats it as reuse.
      if (ambiguous) {
        await new Promise((resolve) => setTimeout(resolve, AMBIGUOUS_REFRESH_REPLAY_DELAY_MS))
      }
      // Reuse concurrent rotations instead of replaying the now-spent token.
      const current = readCloudSession(active.profile.id, userDataPath)
      if (current.status === 'found' && current.session.refreshToken !== session.refreshToken) {
        return { status: 'rotated-elsewhere', session: current.session }
      }
    }
  }
}

async function refreshStoredCloudSession(
  config: OrcaCloudAuthConfig,
  active: ActiveOrcaProfileState,
  userDataPath: string,
  session: OrcaCloudSession
): Promise<OrcaCloudSession> {
  // Single-flight rotating tokens: a duplicate POST can revoke the whole family.
  const key = orcaCloudSessionKey(active.profile.id, userDataPath)
  const inflight = inflightCloudSessionRefreshes.get(key)
  if (inflight) {
    return inflight
  }
  const task = (async () => {
    const current = readCloudSession(active.profile.id, userDataPath)
    if (current.status === 'found' && current.session.refreshToken !== session.refreshToken) {
      return current.session
    }
    if (!active.profile.cloud) {
      throw new StaleCloudSessionMutationError()
    }
    if (blocksAmbiguousRefreshReplay(key, session.refreshToken)) {
      throw new AmbiguousRefreshReplayBlockedError()
    }
    const linked = active.profile.cloud
    const ticket = takeCloudSessionTicket(active.profile.id, userDataPath)
    const attempt = await attemptCloudSessionRefresh(key, config, active, userDataPath, session)
    if (attempt.status === 'rotated-elsewhere') {
      return attempt.session
    }
    const refreshed = attempt.response
    if (
      refreshed.cloud.userId !== linked.userId ||
      refreshed.cloud.cloudProfileId !== linked.cloudProfileId
    ) {
      throw new StaleCloudSessionMutationError()
    }
    const saved = commitCloudSessionRotation(
      active.profile.id,
      userDataPath,
      ticket,
      session,
      refreshed
    )
    if (!saved) {
      throw new StaleCloudSessionMutationError()
    }
    return saved
  })()
  inflightCloudSessionRefreshes.set(key, task)
  try {
    return await task
  } finally {
    inflightCloudSessionRefreshes.delete(key)
  }
}

export async function readFreshOrcaCloudSession(
  config: OrcaCloudAuthConfig,
  active: ActiveOrcaProfileState,
  userDataPath: string
): Promise<FreshCloudSessionResult> {
  const session = readCloudSession(active.profile.id, userDataPath)
  if (session.status !== 'found') {
    return { status: 'reconnect-required' }
  }
  if (!shouldRefreshCloudSession(session.session)) {
    return { status: 'found', session: session.session }
  }
  try {
    return {
      status: 'found',
      session: await refreshStoredCloudSession(config, active, userDataPath, session.session)
    }
  } catch (error) {
    if (isRefreshTokenRejected(error)) {
      warnIfPossibleRefreshReplay(active.profile.id, userDataPath, session.session)
      clearCloudSessionIfUnchanged(active.profile.id, userDataPath, session.session)
      return { status: 'reconnect-required' }
    }
    throw error
  }
}

export async function forceRefreshOrcaCloudSession(
  config: OrcaCloudAuthConfig,
  active: ActiveOrcaProfileState,
  userDataPath: string,
  session: OrcaCloudSession
): Promise<FreshCloudSessionResult> {
  try {
    return {
      status: 'found',
      session: await refreshStoredCloudSession(config, active, userDataPath, session)
    }
  } catch (error) {
    if (isRefreshTokenRejected(error)) {
      warnIfPossibleRefreshReplay(active.profile.id, userDataPath, session)
      clearCloudSessionIfUnchanged(active.profile.id, userDataPath, session)
      return { status: 'reconnect-required' }
    }
    throw error
  }
}

export async function runWithFreshOrcaCloudSession<T>(
  config: OrcaCloudAuthConfig,
  active: ActiveOrcaProfileState,
  userDataPath: string,
  operation: (session: OrcaCloudSession) => Promise<T>
): Promise<CloudSessionOperationResult<T>> {
  const session = await readFreshOrcaCloudSession(config, active, userDataPath)
  if (session.status !== 'found') {
    return { status: 'reconnect-required' }
  }
  try {
    return { status: 'ok', value: await operation(session.session) }
  } catch (error) {
    if (!isAccessTokenRejected(error)) {
      throw error
    }
    // Reuse a rotation that already happened or is in flight; start a new one only once per backoff.
    const key = orcaCloudSessionKey(active.profile.id, userDataPath)
    const stored = readCloudSession(active.profile.id, userDataPath)
    const rotatedSince =
      stored.status === 'found' && stored.session.refreshToken !== session.session.refreshToken
    if (!rotatedSince && !inflightCloudSessionRefreshes.has(key) && !takeForcedRefreshSlot(key)) {
      throw error
    }
    const refreshed = await forceRefreshOrcaCloudSession(
      config,
      active,
      userDataPath,
      session.session
    )
    if (refreshed.status !== 'found') {
      return { status: 'reconnect-required' }
    }
    // The auth server just accepted this session, so a second rejection is the operation's error.
    return { status: 'ok', value: await operation(refreshed.session) }
  }
}
