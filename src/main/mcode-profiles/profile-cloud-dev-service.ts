import type {
  CreateCloudLinkedMCodeProfileArgs,
  MCodeProfileListState
} from '../../shared/mcode-profiles'
import type { ActiveMCodeProfileState } from './profile-index-store'
import { createCloudLinkedMCodeProfileRecord, linkMCodeProfileToCloud } from './profile-cloud-index'
import { readMCodeCloudSession, saveMCodeCloudSessionExchange } from './profile-cloud-session-store'
import { createDevMCodeCloudSession } from './profile-cloud-dev-auth'

type DevProfileListResult = MCodeProfileListState

type DevCreateProfileResult =
  | {
      status: 'created'
      list: ReturnType<typeof createCloudLinkedMCodeProfileRecord>
    }
  | { status: 'reconnect-required' }

type DevMutationResult =
  | {
      status: 'updated'
      list: DevProfileListResult
    }
  | { status: 'reconnect-required' }

export function connectDevMCodeCloudProfile(
  active: ActiveMCodeProfileState,
  userDataPath: string
): DevProfileListResult {
  const session = createDevMCodeCloudSession({ localProfileId: active.profile.id })
  saveMCodeCloudSessionExchange(active.profile.id, userDataPath, session)
  return linkMCodeProfileToCloud(active.profile.id, session.cloud, userDataPath)
}

export function createDevCloudLinkedMCodeProfile(
  active: ActiveMCodeProfileState,
  userDataPath: string,
  args: CreateCloudLinkedMCodeProfileArgs
): DevCreateProfileResult {
  if (readMCodeCloudSession(active.profile.id, userDataPath).status !== 'found') {
    return { status: 'reconnect-required' }
  }
  const session = createDevMCodeCloudSession({ orgId: args.orgId })
  const list = createCloudLinkedMCodeProfileRecord(session.cloud, { name: args.name }, userDataPath)
  saveMCodeCloudSessionExchange(list.profile.id, userDataPath, session)
  return { status: 'created', list }
}

export function refreshDevMCodeCloudProfile(
  active: ActiveMCodeProfileState,
  userDataPath: string
): DevMutationResult {
  if (
    !active.profile.cloud ||
    readMCodeCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevMCodeCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId: active.profile.cloud.activeOrgId
  })
  saveMCodeCloudSessionExchange(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: linkMCodeProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}

export function selectDevMCodeCloudOrg(
  active: ActiveMCodeProfileState,
  userDataPath: string,
  orgId: string
): DevMutationResult {
  if (
    !active.profile.cloud ||
    readMCodeCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevMCodeCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId
  })
  saveMCodeCloudSessionExchange(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: linkMCodeProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}
