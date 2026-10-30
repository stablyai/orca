import {
  persistMirrored,
  readMirroredKeyOrStore,
  readMirroredStorage
} from '../storage/mirrored-storage-keys'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'

export const LAST_VISITED_WORKTREE_STORAGE_KEY = 'orca:last-visited-worktree'

export type LastVisitedWorktreeRecord = {
  hostId: string
  worktreeId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Resume turns this record into navigation; reject incomplete history before it can form an invalid route.
export function readLastVisitedWorktreeRecord(
  raw: string | null
): LastVisitedWorktreeRecord | null {
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !isRecord(parsed) ||
      typeof parsed.hostId !== 'string' ||
      typeof parsed.worktreeId !== 'string' ||
      // Empty ids cannot form an actionable route.
      parsed.hostId === '' ||
      parsed.worktreeId === ''
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
  const repoId = getRepoIdFromWorktreeId(record.worktreeId).trim()
  return repoId || null
}

function extractRecentCardsExtras(raw: string | null | undefined): {
  byHost?: Record<string, unknown>
  recentCards?: unknown[]
  recentCardsMaxDisplay?: number
} {
  if (typeof raw !== 'string') {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) {
      return {}
    }
    const byHost = isRecord(parsed.byHost) ? parsed.byHost : undefined
    const recentCards =
      Array.isArray(parsed.recentCards) && parsed.recentCards.length > 0
        ? parsed.recentCards
        : undefined
    const recentCardsMaxDisplay =
      typeof parsed.recentCardsMaxDisplay === 'number' &&
      Number.isFinite(parsed.recentCardsMaxDisplay)
        ? parsed.recentCardsMaxDisplay
        : undefined
    return {
      ...(byHost ? { byHost } : {}),
      ...(recentCards ? { recentCards } : {}),
      ...(recentCardsMaxDisplay !== undefined ? { recentCardsMaxDisplay } : {})
    }
  } catch {
    return {}
  }
}

/**
 * The one writer of this key, so the hybrid shell's mirror sees it as it is written.
 *
 * The page is handed this key on every `init`, built synchronously from that mirror; a write that
 * went straight to the store would reach the page one `init` later, and the New Workspace drawer
 * would open on the repo the user left rather than the one they just came from.
 */
export function writeLastVisitedWorktree(record: LastVisitedWorktreeRecord): void {
  // Through the path that notes on an accepted write (ruling 35): this module is in the page's
  // own closure, so the store behind it may be the bridge's adapter, which refuses a key this
  // route was never given. Nothing is owed a caller that cannot act on one, so the refusal is the
  // adapter's log rather than a rejection here.
  // Why: a cold mount has no mirror yet, so recent cards are read back from the store before the
  // visit overwrites the key.
  const mirroredRaw = readMirroredStorage([LAST_VISITED_WORKTREE_STORAGE_KEY])[
    LAST_VISITED_WORKTREE_STORAGE_KEY
  ]
  if (mirroredRaw !== undefined) {
    const payload = {
      hostId: record.hostId,
      worktreeId: record.worktreeId,
      ...extractRecentCardsExtras(mirroredRaw)
    }
    void persistMirrored(LAST_VISITED_WORKTREE_STORAGE_KEY, JSON.stringify(payload)).catch(() => {})
    return
  }
  void readMirroredKeyOrStore(LAST_VISITED_WORKTREE_STORAGE_KEY)
    .catch(() => null)
    .then((storedRaw) => {
      const latestMirrored = readMirroredStorage([LAST_VISITED_WORKTREE_STORAGE_KEY])[
        LAST_VISITED_WORKTREE_STORAGE_KEY
      ]
      const payload = {
        hostId: record.hostId,
        worktreeId: record.worktreeId,
        ...extractRecentCardsExtras(latestMirrored ?? storedRaw)
      }
      return persistMirrored(LAST_VISITED_WORKTREE_STORAGE_KEY, JSON.stringify(payload))
    })
    .catch(() => {})
}
