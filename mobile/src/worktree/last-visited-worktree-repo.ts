import { getRepoIdFromMobileWorktreeId } from '../session/mobile-session-route-helpers'

export const LAST_VISITED_WORKTREE_STORAGE_KEY = 'orca:last-visited-worktree'

type LastVisitedWorktreeRecord = {
  hostId: string
  worktreeId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readLastVisitedWorktreeRecord(raw: string | null): LastVisitedWorktreeRecord | null {
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !isRecord(parsed) ||
      typeof parsed.hostId !== 'string' ||
      typeof parsed.worktreeId !== 'string'
    ) {
      return null
    }
    return { hostId: parsed.hostId, worktreeId: parsed.worktreeId }
  } catch {
    return null
  }
}

export function readLastVisitedWorktreeRepoId(raw: string | null, hostId: string): string | null {
  const record = readLastVisitedWorktreeRecord(raw)
  if (!record || record.hostId !== hostId) {
    return null
  }
  const repoId = getRepoIdFromMobileWorktreeId(record.worktreeId).trim()
  return repoId || null
}
