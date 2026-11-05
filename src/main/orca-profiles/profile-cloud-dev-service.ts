import type {
  CreateCloudLinkedOrcaProfileArgs,
  OrcaProfileListState
} from '../../shared/orca-profiles'
import type { ActiveOrcaProfileState } from './profile-index-store'
import { createCloudLinkedOrcaProfileRecord, linkOrcaProfileToCloud } from './profile-cloud-index'
import { readCloudSession, signInCloudSession } from './profile-cloud-session-owner'
import { createDevOrcaCloudSession } from './profile-cloud-dev-auth'

type DevProfileListResult = OrcaProfileListState

type DevCreateProfileResult =
  | {
      status: 'created'
      list: ReturnType<typeof createCloudLinkedOrcaProfileRecord>
    }
  | { status: 'reconnect-required' }

type DevMutationResult =
  | {
      status: 'updated'
      list: DevProfileListResult
    }
  | { status: 'reconnect-required' }

export function connectDevOrcaCloudProfile(
  active: ActiveOrcaProfileState,
  userDataPath: string
): DevProfileListResult {
  const session = createDevOrcaCloudSession({ localProfileId: active.profile.id })
  signInCloudSession(active.profile.id, userDataPath, session)
  return linkOrcaProfileToCloud(active.profile.id, session.cloud, userDataPath)
}

export function createDevCloudLinkedOrcaProfile(
  active: ActiveOrcaProfileState,
  userDataPath: string,
  args: CreateCloudLinkedOrcaProfileArgs
): DevCreateProfileResult {
  if (readCloudSession(active.profile.id, userDataPath).status !== 'found') {
    return { status: 'reconnect-required' }
  }
  const session = createDevOrcaCloudSession({ orgId: args.orgId })
  const list = createCloudLinkedOrcaProfileRecord(session.cloud, { name: args.name }, userDataPath)
  signInCloudSession(list.profile.id, userDataPath, session)
  return { status: 'created', list }
}

export function refreshDevOrcaCloudProfile(
  active: ActiveOrcaProfileState,
  userDataPath: string
): DevMutationResult {
  if (
    !active.profile.cloud ||
    readCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevOrcaCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId: active.profile.cloud.activeOrgId
  })
  signInCloudSession(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: linkOrcaProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}

export function selectDevOrcaCloudOrg(
  active: ActiveOrcaProfileState,
  userDataPath: string,
  orgId: string
): DevMutationResult {
  if (
    !active.profile.cloud ||
    readCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevOrcaCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId
  })
  signInCloudSession(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: linkOrcaProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}
