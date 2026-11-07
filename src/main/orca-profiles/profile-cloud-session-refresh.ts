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

export function isOrcaCloudAuthFailure(error: unknown): boolean {
  return (
    error instanceof OrcaCloudRequestError && (error.statusCode === 401 || error.statusCode === 403)
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
  failed: OrcaCloudSession,
  error: unknown
): void {
  if (!(error instanceof OrcaCloudRequestError) || error.statusCode !== 401) {
    return
  }
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
      // Retry only explicit 5xx rejection; ambiguous failures may have spent the token.
      const retryable = !ambiguous && attempt === 0 && isRetryableCloudRefreshRejection(error)
      if (!ambiguous && !retryable) {
        throw error
      }
      // Reuse concurrent rotations instead of replaying the now-spent token.
      const current = readCloudSession(active.profile.id, userDataPath)
      if (current.status === 'found' && current.session.refreshToken !== session.refreshToken) {
        return { status: 'rotated-elsewhere', session: current.session }
      }
      if (ambiguous) {
        throw error
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
    if (isOrcaCloudAuthFailure(error)) {
      warnIfPossibleRefreshReplay(active.profile.id, userDataPath, session.session, error)
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
    if (isOrcaCloudAuthFailure(error)) {
      warnIfPossibleRefreshReplay(active.profile.id, userDataPath, session, error)
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
    if (!isOrcaCloudAuthFailure(error)) {
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
    try {
      return { status: 'ok', value: await operation(refreshed.session) }
    } catch (retryError) {
      // Post-refresh 401 rejects the session; permission-only 403 must preserve it.
      if (retryError instanceof OrcaCloudRequestError && retryError.statusCode === 401) {
        clearCloudSessionIfUnchanged(active.profile.id, userDataPath, refreshed.session)
        return { status: 'reconnect-required' }
      }
      throw retryError
    }
  }
}
