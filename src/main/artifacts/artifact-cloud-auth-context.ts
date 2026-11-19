import { createHash } from 'node:crypto'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import type { ActiveOrcaProfileState } from '../orca-profiles/profile-index-store'
import {
  readCloudSession,
  takeCloudSessionTicket
} from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import {
  type ArtifactShareScope,
  captureArtifactShareLifecycle,
  isArtifactShareLifecycleCurrent
} from './artifact-share-record-store'

export type ArtifactRateLimitReplay = {
  /** Takes the operation's one 429 wait-and-replay; false once any of its requests used it. */
  claim: () => boolean
  /** Run before the delayed replay: the token must still belong to a signed-in, unchanged account. */
  assertCanReplay: () => void
}

/**
 * One 429 wait-and-replay for a whole artifact operation. Create it before the 401
 * session refresh, which re-runs the operation; a re-run must not earn another wait.
 */
export type ArtifactRateLimitAllowance = { claim: () => boolean }

export function createArtifactRateLimitAllowance(): ArtifactRateLimitAllowance {
  let claimed = false
  return {
    claim: () => {
      if (claimed) {
        return false
      }
      claimed = true
      return true
    }
  }
}

export type ArtifactAuthContext = {
  profileId: string
  scope: ArtifactShareScope
  assertCurrent: () => void
  /** `assertCurrent` plus the session fence a sign-out sets before it awaits remote logout:
   *  what must hold right before a request goes out after an awaited local write. */
  assertCanSend: () => void
  rateLimitReplay: ArtifactRateLimitReplay
}

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function authContext(
  active: ActiveOrcaProfileState,
  scope: ArtifactShareScope,
  userDataPath: string,
  allowance: ArtifactRateLimitAllowance,
  expectedCloud?: { userId: string; profileId: string; organizationId: string }
): ArtifactAuthContext {
  const lifecycleGeneration = captureArtifactShareLifecycle(active.profile.id, userDataPath)
  // Sign-in and sign-out advance this before any network wait; token rotation does not.
  const sessionGeneration = takeCloudSessionTicket(active.profile.id, userDataPath).generation
  const assertCurrent = (): void => {
    const current = ensureActiveOrcaProfile(userDataPath)
    const cloudCurrent =
      !expectedCloud ||
      (current.profile.cloud?.userId === expectedCloud.userId &&
        current.profile.cloud.cloudProfileId === expectedCloud.profileId &&
        (current.profile.cloud.activeOrgId ?? '') === expectedCloud.organizationId)
    if (
      current.profile.id !== active.profile.id ||
      !cloudCurrent ||
      !isArtifactShareLifecycleCurrent(active.profile.id, userDataPath, lifecycleGeneration)
    ) {
      throw new Error('The signed-in Orca account changed while the artifact request was running.')
    }
  }
  // Sign-out fences the session generation before awaiting remote logout, and a revoked
  // session signs out without unlinking, so neither is visible to assertCurrent yet.
  const sessionEnded = (): boolean =>
    Boolean(expectedCloud) &&
    (takeCloudSessionTicket(active.profile.id, userDataPath).generation !== sessionGeneration ||
      readCloudSession(active.profile.id, userDataPath).status !== 'found')
  return {
    profileId: active.profile.id,
    scope,
    assertCurrent,
    assertCanSend: () => {
      assertCurrent()
      if (sessionEnded()) {
        throw new Error(
          'The signed-in Orca account changed while the artifact request was running.'
        )
      }
    },
    rateLimitReplay: {
      claim: allowance.claim,
      assertCanReplay: () => {
        assertCurrent()
        if (sessionEnded()) {
          throw new Error(
            'Signed out of Orca while waiting to retry the artifact request. Sign in and try again.'
          )
        }
      }
    }
  }
}

export function storedSessionAuthContext(
  active: ActiveOrcaProfileState,
  apiOrigin: string,
  userDataPath: string,
  allowance: ArtifactRateLimitAllowance
): ArtifactAuthContext {
  if (!active.profile.cloud) {
    throw new Error('The active Orca profile is not linked to a cloud account.')
  }
  return authContext(
    active,
    {
      cloudUserId: active.profile.cloud.userId,
      cloudProfileId: active.profile.cloud.cloudProfileId,
      cloudOrganizationId: active.profile.cloud.activeOrgId ?? '',
      apiOrigin
    },
    userDataPath,
    allowance,
    {
      userId: active.profile.cloud.userId,
      profileId: active.profile.cloud.cloudProfileId,
      organizationId: active.profile.cloud.activeOrgId ?? ''
    }
  )
}

export function explicitTokenAuthContext(
  active: ActiveOrcaProfileState,
  apiOrigin: string,
  token: string,
  userDataPath: string,
  allowance: ArtifactRateLimitAllowance
): ArtifactAuthContext {
  const fingerprint = tokenFingerprint(token)
  return authContext(
    active,
    {
      cloudUserId: `token:${fingerprint}`,
      cloudProfileId: `token:${fingerprint}`,
      cloudOrganizationId: `token:${fingerprint}`,
      apiOrigin
    },
    userDataPath,
    allowance
  )
}
