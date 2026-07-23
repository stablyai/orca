import { getRepoIdFromMobileWorktreeId } from '../session/mobile-session-route-helpers'

export const LAST_VISITED_WORKTREE_STORAGE_KEY = 'orca:last-visited-worktree'
export const LAST_VISITED_WORKTREE_MAX_STORAGE_CHARACTERS = 16 * 1024
export const LAST_VISITED_WORKTREE_MAX_ID_CHARACTERS = 4_096

export type LastVisitedWorktreeRecord = {
  hostId: string
  worktreeId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function readLastVisitedWorktreeRecord(
  raw: string | null
): LastVisitedWorktreeRecord | null {
  if (!raw || raw.length > LAST_VISITED_WORKTREE_MAX_STORAGE_CHARACTERS) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !isRecord(parsed) ||
      typeof parsed.hostId !== 'string' ||
      parsed.hostId.length === 0 ||
      parsed.hostId.length > LAST_VISITED_WORKTREE_MAX_ID_CHARACTERS ||
      typeof parsed.worktreeId !== 'string' ||
      parsed.worktreeId.length === 0 ||
      parsed.worktreeId.length > LAST_VISITED_WORKTREE_MAX_ID_CHARACTERS
    ) {
      return null
    }
    return { hostId: parsed.hostId, worktreeId: parsed.worktreeId }
  } catch {
    return null
  }
}

export function serializeLastVisitedWorktreeRecord(
  record: LastVisitedWorktreeRecord
): string | null {
  if (
    record.hostId.length === 0 ||
    record.hostId.length > LAST_VISITED_WORKTREE_MAX_ID_CHARACTERS ||
    record.worktreeId.length === 0 ||
    record.worktreeId.length > LAST_VISITED_WORKTREE_MAX_ID_CHARACTERS
  ) {
    return null
  }
  const serialized = JSON.stringify(record)
  if (serialized.length > LAST_VISITED_WORKTREE_MAX_STORAGE_CHARACTERS) {
    return null
  }
  return serialized
}

export function readLastVisitedWorktreeRepoId(raw: string | null, hostId: string): string | null {
  const record = readLastVisitedWorktreeRecord(raw)
  if (!record || record.hostId !== hostId) {
    return null
  }
  const repoId = getRepoIdFromMobileWorktreeId(record.worktreeId).trim()
  return repoId || null
}
