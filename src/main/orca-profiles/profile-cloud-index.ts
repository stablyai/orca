import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type {
  OrcaProfileCloudSummary,
  OrcaProfileListState,
  OrcaProfileSummary
} from '../../shared/orca-profiles'
import {
  getOrcaProfileDirectory,
  getOrcaProfileIndexPath,
  loadOrCreateProfileIndex,
  writeProfileIndex
} from './profile-index-store'

export type CreateCloudLinkedOrcaProfileRecordResult = OrcaProfileListState & {
  profile: OrcaProfileSummary
}

function sanitizeProfileName(value: unknown, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return (trimmed || fallback).slice(0, 80)
}

function profileInitial(name: string): string {
  return (name.match(/[A-Za-z0-9]/)?.[0] ?? 'C').toUpperCase()
}

function toCloudLinkedProfile(
  profile: OrcaProfileSummary,
  cloud: OrcaProfileCloudSummary,
  now: number
): OrcaProfileSummary {
  return {
    ...profile,
    kind: 'cloud-linked',
    cloud,
    updatedAt: now,
    lastOpenedAt: now
  }
}

function toLocalProfile(profile: OrcaProfileSummary, now: number): OrcaProfileSummary {
  const { cloud: _cloud, ...localProfile } = profile
  return {
    ...localProfile,
    kind: 'local',
    updatedAt: now,
    lastOpenedAt: now
  }
}

export function createCloudLinkedOrcaProfileRecord(
  cloud: OrcaProfileCloudSummary,
  args: { name?: string },
  userDataPath: string
): CreateCloudLinkedOrcaProfileRecordResult {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  const fallbackName = cloud.activeOrgName ?? cloud.displayName ?? cloud.email
  const name = sanitizeProfileName(args.name, fallbackName)
  const profile: OrcaProfileSummary = {
    id: `cloud-${randomUUID()}`,
    name,
    avatar: {
      kind: 'initials',
      initials: profileInitial(name),
      color: 'neutral'
    },
    kind: 'cloud-linked',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    cloud
  }
  const nextIndex = {
    ...index,
    profiles: [...index.profiles, profile]
  }
  mkdirSync(getOrcaProfileDirectory(profile.id, userDataPath), { recursive: true })
  writeProfileIndex(getOrcaProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles,
    profile
  }
}

export function linkOrcaProfileToCloud(
  profileId: string,
  cloud: OrcaProfileCloudSummary,
  userDataPath: string
): OrcaProfileListState {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  let found = false
  const profiles = index.profiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile
    }
    found = true
    return toCloudLinkedProfile(profile, cloud, now)
  })
  if (!found) {
    throw new Error('unknown_orca_profile')
  }
  const nextIndex = {
    ...index,
    profiles
  }
  writeProfileIndex(getOrcaProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}

export function unlinkOrcaProfileFromCloud(
  profileId: string,
  userDataPath: string
): OrcaProfileListState {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  let found = false
  const profiles = index.profiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile
    }
    found = true
    return toLocalProfile(profile, now)
  })
  if (!found) {
    throw new Error('unknown_orca_profile')
  }
  const nextIndex = {
    ...index,
    profiles
  }
  writeProfileIndex(getOrcaProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}
