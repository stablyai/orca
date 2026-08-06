import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFile } from '../../shared/secure-file'
import type { OrcaProfileCloudSummary } from '../../shared/orca-profiles'
import { getOrcaProfileDirectory } from './profile-storage-paths'

const MUTATION_STATE_VERSION = 1

export type CloudSessionIdentity = {
  localProfileId: string
  cloudUserId: string
  cloudProfileId: string
  organizationId: string
}

export type CloudSessionMutationSnapshot = {
  epoch: number
  identityKey: string
}

type CloudSessionMutationState = {
  version: 1
  epoch: number
  expectedIdentityKey: string
  tombstonedIdentityKeys: string[]
}

function identityKey(identity: CloudSessionIdentity): string {
  return `${identity.localProfileId}\0${identity.cloudUserId}\0${identity.cloudProfileId}\0${identity.organizationId}`
}

function statePath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'account-session-mutation.json')
}

function isState(value: unknown): value is CloudSessionMutationState {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<CloudSessionMutationState>
  return (
    candidate.version === MUTATION_STATE_VERSION &&
    Number.isSafeInteger(candidate.epoch) &&
    Number(candidate.epoch) >= 0 &&
    typeof candidate.expectedIdentityKey === 'string' &&
    Array.isArray(candidate.tombstonedIdentityKeys) &&
    candidate.tombstonedIdentityKeys.every((key) => typeof key === 'string')
  )
}

function readState(profileId: string, userDataPath: string): CloudSessionMutationState | null {
  const path = statePath(profileId, userDataPath)
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!isState(parsed)) {
      throw new Error('invalid_cloud_session_mutation_state')
    }
    return parsed
  } catch {
    throw new Error('invalid_cloud_session_mutation_state')
  }
}

function saveState(
  profileId: string,
  userDataPath: string,
  state: CloudSessionMutationState
): void {
  writeSecureJsonFile(statePath(profileId, userDataPath), state)
}

export function cloudSessionIdentity(
  localProfileId: string,
  cloud: OrcaProfileCloudSummary
): CloudSessionIdentity {
  return {
    localProfileId,
    cloudUserId: cloud.userId,
    cloudProfileId: cloud.cloudProfileId,
    organizationId: cloud.activeOrgId ?? ''
  }
}

export function captureCloudSessionMutation(
  identity: CloudSessionIdentity,
  userDataPath: string
): CloudSessionMutationSnapshot {
  const key = identityKey(identity)
  let state = readState(identity.localProfileId, userDataPath)
  if (!state) {
    state = {
      version: MUTATION_STATE_VERSION,
      epoch: 0,
      expectedIdentityKey: key,
      tombstonedIdentityKeys: []
    }
    saveState(identity.localProfileId, userDataPath, state)
  }
  return { epoch: state.epoch, identityKey: key }
}

export function recordSuccessfulCloudSessionLogin(
  identity: CloudSessionIdentity,
  userDataPath: string
): CloudSessionMutationSnapshot {
  const key = identityKey(identity)
  const previous = readState(identity.localProfileId, userDataPath)
  const state: CloudSessionMutationState = {
    version: MUTATION_STATE_VERSION,
    epoch: (previous?.epoch ?? -1) + 1,
    expectedIdentityKey: key,
    tombstonedIdentityKeys: (previous?.tombstonedIdentityKeys ?? []).filter(
      (candidate) => candidate !== key
    )
  }
  saveState(identity.localProfileId, userDataPath, state)
  return { epoch: state.epoch, identityKey: key }
}

export function recordCloudSessionIdentityMutation(
  identity: CloudSessionIdentity,
  userDataPath: string
): CloudSessionMutationSnapshot {
  const key = identityKey(identity)
  const previous = readState(identity.localProfileId, userDataPath)
  const state: CloudSessionMutationState = {
    version: MUTATION_STATE_VERSION,
    epoch: (previous?.epoch ?? -1) + 1,
    expectedIdentityKey: key,
    tombstonedIdentityKeys: previous?.tombstonedIdentityKeys ?? []
  }
  saveState(identity.localProfileId, userDataPath, state)
  return { epoch: state.epoch, identityKey: key }
}

export function tombstoneCloudSession(identity: CloudSessionIdentity, userDataPath: string): void {
  const key = identityKey(identity)
  const previous = readState(identity.localProfileId, userDataPath)
  const tombstones = new Set(previous?.tombstonedIdentityKeys ?? [])
  tombstones.add(key)
  saveState(identity.localProfileId, userDataPath, {
    version: MUTATION_STATE_VERSION,
    epoch: (previous?.epoch ?? -1) + 1,
    expectedIdentityKey: key,
    tombstonedIdentityKeys: [...tombstones]
  })
}

export function isCloudSessionMutationCurrent(
  profileId: string,
  userDataPath: string,
  snapshot: CloudSessionMutationSnapshot
): boolean {
  const state = readState(profileId, userDataPath)
  return Boolean(
    state &&
    state.epoch === snapshot.epoch &&
    state.expectedIdentityKey === snapshot.identityKey &&
    !state.tombstonedIdentityKeys.includes(snapshot.identityKey)
  )
}

export function recordCloudSessionIdentityMutationIfCurrent(
  identity: CloudSessionIdentity,
  userDataPath: string,
  snapshot: CloudSessionMutationSnapshot
): CloudSessionMutationSnapshot | null {
  if (!isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, snapshot)) {
    return null
  }
  return recordCloudSessionIdentityMutation(identity, userDataPath)
}
