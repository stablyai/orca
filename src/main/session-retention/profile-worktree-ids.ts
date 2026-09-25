import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { folderWorkspaceKey } from '../../shared/workspace-scope'

const PROFILE_INDEX_FILE = 'orca-profile-index.json'
const PROFILE_DATA_FILE = 'orca-data.json'

export type ProfileWorktreeIdRead = {
  ids: Set<string>
  unreadableProfiles: number
  profilesRead: number
}

/** Worktree ids from every on-disk profile, including the active one. */
export function readProfileWorktreeIdsForRetention(userDataPath: string): ProfileWorktreeIdRead {
  const index = readJsonWithBackup(join(userDataPath, PROFILE_INDEX_FILE))
  if (index.kind === 'missing') {
    const legacy = readWorktreeIds(join(userDataPath, PROFILE_DATA_FILE))
    if (legacy === 'missing') {
      return { ids: new Set(), unreadableProfiles: 0, profilesRead: 0 }
    }
    if (legacy === 'unreadable') {
      return { ids: new Set(), unreadableProfiles: 1, profilesRead: 0 }
    }
    return { ids: legacy, unreadableProfiles: 0, profilesRead: 1 }
  }
  const profileIds = index.kind === 'ok' ? profileIdsFromIndex(index.value) : null
  if (!profileIds) {
    return { ids: new Set(), unreadableProfiles: 1, profilesRead: 0 }
  }
  const ids = new Set<string>()
  let unreadableProfiles = 0
  let profilesRead = 0
  for (const profileId of profileIds) {
    const collected = readWorktreeIds(join(userDataPath, 'profiles', profileId, PROFILE_DATA_FILE))
    if (collected === 'missing' || collected === 'unreadable') {
      unreadableProfiles += 1
      continue
    }
    profilesRead += 1
    for (const id of collected) {
      ids.add(id)
    }
  }
  return { ids, unreadableProfiles, profilesRead }
}

function profileIdsFromIndex(index: unknown): string[] | null {
  if (!isRecord(index) || !Array.isArray(index.profiles)) {
    return null
  }
  const ids: string[] = []
  for (const profile of index.profiles) {
    if (!isRecord(profile) || typeof profile.id !== 'string' || profile.id.length === 0) {
      return null
    }
    ids.push(profile.id)
  }
  return ids
}

function readWorktreeIds(dataFile: string): Set<string> | 'missing' | 'unreadable' {
  const parsed = readJsonFile(dataFile)
  if (parsed.kind === 'missing') {
    return 'missing'
  }
  if (parsed.kind !== 'ok' || !isRecord(parsed.value)) {
    return 'unreadable'
  }
  const record = parsed.value
  const ids = new Set<string>()
  if (isRecord(record.worktreeMeta)) {
    for (const id of Object.keys(record.worktreeMeta)) {
      ids.add(id)
    }
  }
  if (Array.isArray(record.folderWorkspaces)) {
    for (const workspace of record.folderWorkspaces) {
      if (isRecord(workspace) && typeof workspace.id === 'string' && workspace.id) {
        ids.add(folderWorkspaceKey(workspace.id))
      }
    }
  }
  return ids
}

function readJsonWithBackup(
  path: string
): { kind: 'ok'; value: unknown } | { kind: 'missing' | 'unreadable' } {
  const primary = readJsonFile(path)
  if (primary.kind === 'ok') {
    return primary
  }
  const backup = readJsonFile(`${path}.bak`)
  if (backup.kind === 'ok') {
    return backup
  }
  return {
    kind: primary.kind === 'missing' && backup.kind === 'missing' ? 'missing' : 'unreadable'
  }
}

function readJsonFile(
  path: string
): { kind: 'ok'; value: unknown } | { kind: 'missing' | 'unreadable' } {
  try {
    return { kind: 'ok', value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { kind: isMissingFile(error) ? 'missing' : 'unreadable' }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
