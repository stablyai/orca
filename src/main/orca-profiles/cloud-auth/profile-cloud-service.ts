export { signOutCurrentOrcaProfile } from './profile-cloud-service-sign-out'
import type {
  ConnectCurrentOrcaProfileResult,
  CreateCloudLinkedOrcaProfileArgs,
  CreateCloudLinkedOrcaProfileResult,
  OrcaProfileAuthStatus,
  SelectOrcaProfileOrgResult
} from '../../../shared/orca-profiles/orca-profiles'
import { ensureActiveOrcaProfile } from '../profile-index-store'
import { getOrcaCloudAuthConfig, isOrcaCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { signInCloudSession } from '../cloud-session/profile-cloud-session-owner'
import { createOrcaCloudProfile, exchangeOrcaCloudAuthCode } from './profile-cloud-client'
import { beginOrcaCloudPkceFlow, type OrcaCloudBrowserReturn } from './profile-cloud-pkce'
import { orcaCloudCallbackOutcomeOf } from './profile-cloud-callback-page'
import { createCloudLinkedOrcaProfileRecord } from './profile-cloud-index'
import { runWithFreshOrcaCloudSession } from '../cloud-session/profile-cloud-session-refresh'
import {
  connectDevOrcaCloudProfile,
  createDevCloudLinkedOrcaProfile,
  selectDevOrcaCloudOrg
} from './profile-cloud-dev-service'
import { getOrcaProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { selectCloudOrg } from '../cloud-org/profile-cloud-org-selection'
import {
  endOrcaCloudSignInProgress,
  setOrcaCloudSignInLink,
  startOrcaCloudSignInProgress
} from './profile-cloud-sign-in-progress'

import './profile-cloud-capability-refresh'
import {
  commitExchangedCloudSession,
  type CloudSessionCommitGuards
} from '../cloud-session/profile-cloud-session-commit'
import * as connectAttempts from './profile-cloud-connect-attempts'

export async function getCurrentOrcaProfileAuthStatus(
  userDataPath: string
): Promise<OrcaProfileAuthStatus> {
  return getOrcaProfileAuthStatusFromProfile(ensureActiveOrcaProfile(userDataPath), userDataPath)
}

export async function connectCurrentOrcaProfile(
  userDataPath: string,
  openBrowser: (url: string) => Promise<void>,
  mayCommit?: CloudSessionCommitGuards['mayCommit']
): Promise<ConnectCurrentOrcaProfileResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    const list = await connectDevOrcaCloudProfile(active, userDataPath)
    return {
      status: 'connected',
      auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  }

  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return {
      status: 'unconfigured',
      auth: await getOrcaProfileAuthStatusFromProfile(active, userDataPath)
    }
  }

  const attempt = connectAttempts.beginCloudConnectAttempt()
  const browserWait = new AbortController()
  startOrcaCloudSignInProgress(attempt, () => browserWait.abort())
  let respondToBrowser: OrcaCloudBrowserReturn['respond'] | undefined
  const finish = (result: ConnectCurrentOrcaProfileResult): ConnectCurrentOrcaProfileResult => {
    respondToBrowser?.(orcaCloudCallbackOutcomeOf(result))
    return result
  }
  try {
    const code = await beginOrcaCloudPkceFlow(configState.config, active.profile.id, {
      openBrowser,
      signal: browserWait.signal,
      onAuthorizeUrl: (link) => setOrcaCloudSignInLink(attempt, link)
    })
    respondToBrowser = code.respond
    // The browser came back, so its link is spent.
    setOrcaCloudSignInLink(attempt, null)
    if (connectAttempts.isCloudConnectAttemptSuperseded(attempt)) {
      return finish({
        status: 'cancelled',
        auth: await getCurrentOrcaProfileAuthStatus(userDataPath)
      })
    }
    const exchange = await exchangeOrcaCloudAuthCode(configState.config, {
      ...code,
      localProfileId: active.profile.id
    })
    const outcome = await commitExchangedCloudSession({
      config: configState.config,
      profileId: active.profile.id,
      userDataPath,
      attempt,
      exchange,
      guards: { mayCommit }
    })
    if (outcome.status === 'cancelled') {
      return finish({
        status: 'cancelled',
        auth: await getCurrentOrcaProfileAuthStatus(userDataPath)
      })
    }
    if (outcome.status === 'refused') {
      return finish({
        status: 'failed',
        auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
        error: outcome.error
      })
    }
    return finish({
      status: 'connected',
      auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: outcome.list.activeProfileId,
      profiles: outcome.list.profiles
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      message === 'orca_cloud_auth_timeout' &&
      connectAttempts.isNewestCloudConnectAttempt(attempt)
    ) {
      return finish({
        status: 'timed-out',
        auth: await getCurrentOrcaProfileAuthStatus(userDataPath)
      })
    }
    if (
      message === 'orca_cloud_auth_timeout' ||
      message === 'orca_cloud_auth_denied' ||
      message === 'orca_cloud_auth_cancelled'
    ) {
      return finish({
        status: 'cancelled',
        auth: await getCurrentOrcaProfileAuthStatus(userDataPath)
      })
    }
    return finish({
      status: 'failed',
      auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
      error: message
    })
  } finally {
    endOrcaCloudSignInProgress(attempt)
  }
}

export async function createCloudLinkedOrcaProfile(
  userDataPath: string,
  args: CreateCloudLinkedOrcaProfileArgs
): Promise<CreateCloudLinkedOrcaProfileResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    const result = await createDevCloudLinkedOrcaProfile(active, userDataPath, args)
    if (result.status !== 'created') {
      return {
        status: 'reconnect-required',
        auth: await getOrcaProfileAuthStatusFromProfile(active, userDataPath)
      }
    }
    return {
      status: 'created',
      auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles,
      profile: result.list.profile
    }
  }

  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return {
      status: 'unconfigured',
      auth: await getOrcaProfileAuthStatusFromProfile(active, userDataPath)
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
        auth: await getOrcaProfileAuthStatusFromProfile(active, userDataPath)
      }
    }
    const created = operation.value
    const list = createCloudLinkedOrcaProfileRecord(
      created.cloud,
      { name: args.name },
      userDataPath
    )
    await signInCloudSession(list.profile.id, userDataPath, created)
    return {
      status: 'created',
      auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles,
      profile: list.profile
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function selectCurrentOrcaProfileOrg(
  userDataPath: string,
  orgId: string
): Promise<SelectOrcaProfileOrgResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    const result = await selectDevOrcaCloudOrg(active, userDataPath, orgId)
    if (result.status !== 'updated') {
      return {
        status: 'reconnect-required',
        auth: await getOrcaProfileAuthStatusFromProfile(active, userDataPath)
      }
    }
    return {
      status: 'selected',
      auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles
    }
  }

  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return {
      status: 'unconfigured',
      auth: await getOrcaProfileAuthStatusFromProfile(active, userDataPath)
    }
  }
  try {
    const list = await selectCloudOrg({
      config: configState.config,
      active,
      userDataPath,
      orgId
    })
    if (!list) {
      return {
        status: 'reconnect-required',
        auth: await getOrcaProfileAuthStatusFromProfile(active, userDataPath)
      }
    }
    return {
      status: 'selected',
      auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: await getCurrentOrcaProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
