import type { ConnectCurrentOrcaProfileResult } from '../../../shared/orca-profiles/orca-profiles'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { exchangeOrcaCloudAuthCode } from './profile-cloud-client'
import { beginCloudConnectAttempt } from './profile-cloud-connect-attempts'
import type { OrcaCloudAuthorizationCode } from './profile-cloud-pkce'
import { getCurrentOrcaProfileAuthStatus } from './profile-cloud-service'
import {
  commitExchangedCloudSession,
  type CloudSessionCommitGuards
} from '../cloud-session/profile-cloud-session-commit'
import { ensureActiveOrcaProfile } from '../profile-index-store'

/** Redeems a code whose browser leg ran on another device; the verifier never left this host. */
export async function signInCurrentOrcaProfileWithCode(
  userDataPath: string,
  config: OrcaCloudAuthConfig,
  code: OrcaCloudAuthorizationCode,
  guards: CloudSessionCommitGuards = {}
): Promise<ConnectCurrentOrcaProfileResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  const attempt = beginCloudConnectAttempt()
  const auth = () => getCurrentOrcaProfileAuthStatus(userDataPath)
  let exchange: Awaited<ReturnType<typeof exchangeOrcaCloudAuthCode>>
  try {
    exchange = await exchangeOrcaCloudAuthCode(config, {
      ...code,
      localProfileId: active.profile.id
    })
  } catch (error) {
    return {
      status: 'failed',
      auth: auth(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
  const outcome = await commitExchangedCloudSession({
    config,
    profileId: active.profile.id,
    userDataPath,
    attempt,
    exchange,
    guards
  })
  if (outcome.status === 'cancelled') {
    return { status: 'cancelled', auth: auth() }
  }
  if (outcome.status === 'refused') {
    return { status: 'failed', auth: auth(), error: outcome.error }
  }
  return {
    status: 'connected',
    auth: auth(),
    activeProfileId: outcome.list.activeProfileId,
    profiles: outcome.list.profiles
  }
}
