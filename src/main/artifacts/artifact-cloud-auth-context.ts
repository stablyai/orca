import { createHash } from 'node:crypto'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import type { ActiveOrcaProfileState } from '../orca-profiles/profile-index-store'
import { readCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import {
  type ArtifactShareScope,
  captureArtifactShareLifecycle,
  isArtifactShareLifecycleCurrent
} from './artifact-share-record-store'

export type ArtifactAuthContext = {
  profileId: string
  scope: ArtifactShareScope
  assertCurrent: () => void
  /** Run before a delayed rate-limit replay: the token must still belong to a signed-in, unchanged account. */
  assertCanReplay: () => void
}

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function authContext(
  active: ActiveOrcaProfileState,
  scope: ArtifactShareScope,
  userDataPath: string,
  expectedCloud?: { userId: string; profileId: string; organizationId: string }
): ArtifactAuthContext {
  const lifecycleGeneration = captureArtifactShareLifecycle(active.profile.id, userDataPath)
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
  return {
    profileId: active.profile.id,
    scope,
    assertCurrent,
    assertCanReplay: () => {
      assertCurrent()
      // A revoked session signs out without unlinking the profile, so check the session itself.
      if (expectedCloud && readCloudSession(active.profile.id, userDataPath).status !== 'found') {
        throw new Error(
          'Signed out of Orca while waiting to retry the artifact request. Sign in and try again.'
        )
      }
    }
  }
}

export function storedSessionAuthContext(
  active: ActiveOrcaProfileState,
  apiOrigin: string,
  userDataPath: string
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
  userDataPath: string
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
    userDataPath
  )
}
