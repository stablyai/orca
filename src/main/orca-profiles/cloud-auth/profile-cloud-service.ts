import {
  clearSignedOutCloudData,
  ORCA_CLOUD_AUTH_STOPPED_ERRORS,
  revokeCloudReaderKeyBestEffort,
  type OrcaCloudSetupSignIn
} from './profile-cloud-sign-in-session-data'
import type {
  ConnectCurrentOrcaProfileResult,
  CreateCloudLinkedOrcaProfileArgs,
  CreateCloudLinkedOrcaProfileResult,
  OrcaProfileAuthStatus,
  SignOutCurrentOrcaProfileResult
} from '../../../shared/orca-profiles/orca-profiles'
import { ensureActiveOrcaProfile } from '../profile-index-store'
import { getOrcaCloudAuthConfig, isOrcaCloudDevAuthEnabled } from './profile-cloud-auth-config'
import {
  invalidateCloudSessionChanges,
  readCloudSession,
  signInCloudSession,
  signOutCloudSession
} from '../cloud-session/profile-cloud-session-owner'
import {
  createOrcaCloudProfile,
  exchangeOrcaCloudAuthCode,
  revokeOrcaCloudSession
} from './profile-cloud-client'
import {
  beginOrcaCloudPkceFlow,
  pkceSignInOptions,
  type OrcaCloudAuthorizationCode
} from './profile-cloud-pkce'
import {
  createCloudLinkedOrcaProfileRecord,
  linkOrcaProfileToCloud,
  unlinkOrcaProfileFromCloud
} from './profile-cloud-index'
import { runWithFreshOrcaCloudSession } from '../cloud-session/profile-cloud-session-refresh'
import {
  connectDevOrcaCloudProfile,
  createDevCloudLinkedOrcaProfile
} from './profile-cloud-dev-service'
import { getOrcaProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import {
  cancelOrcaCloudSignIn,
  endOrcaCloudSignInProgress,
  setOrcaCloudSignInLink,
  startOrcaCloudSignInProgress
} from './profile-cloud-sign-in-progress'
import { clearRelayRegionPreferenceCache } from '../../runtime/mobile-cloud-relay/region-selection/relay-region-preference'

import './profile-cloud-capability-refresh'

// Org switching lives beside the org selection it drives; callers keep importing it from here.
export { selectCurrentOrcaProfileOrg } from '../cloud-org/profile-cloud-org-select-current'

let nextCloudConnectAttempt = 0
let linkedCloudConnectAttempt = 0

function invalidateOutstandingCloudConnectAttempts(): void {
  nextCloudConnectAttempt += 1
  linkedCloudConnectAttempt = nextCloudConnectAttempt
  // Also closes the pending loopback listener, so a late browser callback has nowhere to land.
  cancelOrcaCloudSignIn()
}

export function getCurrentOrcaProfileAuthStatus(userDataPath: string): OrcaProfileAuthStatus {
  return getOrcaProfileAuthStatusFromProfile(ensureActiveOrcaProfile(userDataPath), userDataPath)
}

export async function connectCurrentOrcaProfile(
  userDataPath: string,
  /** Cloud setup's sign-in, or (COPY-LINK-FIRST-CLICK) a plain one that may skip the browser. */
  setup?: OrcaCloudSetupSignIn | { openBrowser?: boolean }
): Promise<ConnectCurrentOrcaProfileResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    const list = connectDevOrcaCloudProfile(active, userDataPath)
    return {
      status: 'connected',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  }

  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return {
      status: 'unconfigured',
      auth: getOrcaProfileAuthStatusFromProfile(active, userDataPath)
    }
  }

  const attempt = ++nextCloudConnectAttempt
  // Cancel (or a newer attempt) aborts this one at any stage before the session is saved.
  const attemptAbort = new AbortController()
  let browser: Pick<OrcaCloudAuthorizationCode, 'respond' | 'redirect'> | undefined
  // Every outcome also answers the browser tab still waiting on the loopback callback.
  const finish = (result: ConnectCurrentOrcaProfileResult): ConnectCurrentOrcaProfileResult => {
    browser?.respond(
      result.status === 'failed'
        ? { status: 'failed', error: result.error }
        : { status: result.auth.state === 'connected' ? 'connected' : 'cancelled' }
    )
    return result
  }
  const cancelled = (): ConnectCurrentOrcaProfileResult =>
    finish({
      status: 'cancelled',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath)
    })
  const stale = (): boolean => attempt < linkedCloudConnectAttempt || attemptAbort.signal.aborted
  let end: 'timed-out' | undefined
  startOrcaCloudSignInProgress(attempt, () => attemptAbort.abort())
  try {
    const code = await beginOrcaCloudPkceFlow(configState.config, active.profile.id, {
      signal: attemptAbort.signal,
      onAuthorizeUrl: (link) => setOrcaCloudSignInLink(attempt, link),
      ...pkceSignInOptions(setup)
    })
    browser = code
    // The callback listener has closed, so its browser link is dead.
    setOrcaCloudSignInLink(attempt, null)
    if (stale()) {
      return cancelled()
    }
    const exchange = await exchangeOrcaCloudAuthCode(configState.config, {
      code: code.code,
      codeVerifier: code.codeVerifier,
      nonce: code.nonce,
      redirectUri: code.redirectUri,
      state: code.state,
      localProfileId: active.profile.id
    })
    if (stale()) {
      return cancelled()
    }
    signInCloudSession(active.profile.id, userDataPath, exchange)
    const list = linkOrcaProfileToCloud(active.profile.id, exchange.cloud, userDataPath)
    linkedCloudConnectAttempt = attempt
    if (setup && 'afterSignIn' in setup) {
      // Cloud setup continues in the same tab when it has a next page to show.
      const next = await setup.afterSignIn().catch(() => null)
      if (next) {
        code.redirect(next)
      }
    }
    return finish({
      status: 'connected',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!stale() && message === 'orca_cloud_auth_timeout' && attempt === nextCloudConnectAttempt) {
      end = 'timed-out'
      return finish({ status: 'timed-out', auth: getCurrentOrcaProfileAuthStatus(userDataPath) })
    }
    if (attemptAbort.signal.aborted || ORCA_CLOUD_AUTH_STOPPED_ERRORS.has(message)) {
      return cancelled()
    }
    return finish({
      status: 'failed',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      error: message
    })
  } finally {
    // Every return above answered the tab already; this only covers an unexpected throw.
    browser?.respond({ status: 'cancelled' })
    endOrcaCloudSignInProgress(attempt, end)
  }
}

export async function signOutCurrentOrcaProfile(
  userDataPath: string
): Promise<SignOutCurrentOrcaProfileResult> {
  // Pending browser sign-ins must not relink after explicit sign-out.
  invalidateOutstandingCloudConnectAttempts()
  const signOutEpoch = linkedCloudConnectAttempt
  const active = ensureActiveOrcaProfile(userDataPath)
  const configState = getOrcaCloudAuthConfig()
  const session = readCloudSession(active.profile.id, userDataPath)
  if (session.status === 'found') {
    // While the session still mints tokens: revoke this device's reader key server-side so no
    // later sleep seals to it. Bounded (a couple of seconds) and never fails the sign-out.
    await revokeCloudReaderKeyBestEffort()
  }
  // Fence before network I/O so in-flight refreshes cannot save after sign-out.
  invalidateCloudSessionChanges(active.profile.id, userDataPath)
  if (!isOrcaCloudDevAuthEnabled() && configState.configured && session.status === 'found') {
    await revokeOrcaCloudSession(configState.config, session.session).catch(() => undefined)
  }
  if (linkedCloudConnectAttempt > signOutEpoch) {
    const current = ensureActiveOrcaProfile(userDataPath)
    return {
      status: 'signed-out',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: current.index.activeProfileId,
      profiles: current.index.profiles
    }
  }
  signOutCloudSession(active.profile.id, userDataPath)
  const list = unlinkOrcaProfileFromCloud(active.profile.id, userDataPath)
  await clearSignedOutCloudData(active.profile.id, userDataPath)
  try {
    clearRelayRegionPreferenceCache(userDataPath)
  } catch {
    // A leftover latency cache must not fail the sign-out itself.
  }
  return {
    status: 'signed-out',
    auth: getCurrentOrcaProfileAuthStatus(userDataPath),
    activeProfileId: list.activeProfileId,
    profiles: list.profiles
  }
}

export async function createCloudLinkedOrcaProfile(
  userDataPath: string,
  args: CreateCloudLinkedOrcaProfileArgs
): Promise<CreateCloudLinkedOrcaProfileResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    const result = createDevCloudLinkedOrcaProfile(active, userDataPath, args)
    if (result.status !== 'created') {
      return {
        status: 'reconnect-required',
        auth: getOrcaProfileAuthStatusFromProfile(active, userDataPath)
      }
    }
    return {
      status: 'created',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles,
      profile: result.list.profile
    }
  }

  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return {
      status: 'unconfigured',
      auth: getOrcaProfileAuthStatusFromProfile(active, userDataPath)
    }
  }
  try {
    const operation = await runWithFreshOrcaCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => createOrcaCloudProfile(configState.config, session, args)
    )
    if (operation.status !== 'ok') {
      return {
        status: 'reconnect-required',
        auth: getOrcaProfileAuthStatusFromProfile(active, userDataPath)
      }
    }
    const created = operation.value
    const list = createCloudLinkedOrcaProfileRecord(
      created.cloud,
      { name: args.name },
      userDataPath
    )
    signInCloudSession(list.profile.id, userDataPath, created)
    return {
      status: 'created',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles,
      profile: list.profile
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
