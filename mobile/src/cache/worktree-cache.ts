// Why: module-level cache lets the home screen pre-populate worktree data
// so the host detail page can render instantly on navigation instead of
// waiting for a fresh RPC connection + fetch cycle.

import { readMergedWorktreeRows } from '../worktree/merged-desktop-catalog-response'
import type { HomeWorktreeSummary } from '../worktree/home-worktree-info'
import type { Worktree } from '../worktree/workspace-list-types'

type CachedWorktrees = {
  worktrees: Worktree[] | HomeWorktreeSummary[]
  at: number
  // Whether the host itself listed these rows this session, as opposed to a cold-start seed
  // rebuilt from a persisted snapshot. Only a proven list can prove a worktree *absent*.
  proven: boolean
}

const cache = new Map<string, CachedWorktrees>()

const MAX_AGE_MS = 30_000
const MAX_ENTRIES = 20

export function setCachedWorktrees(
  hostId: string,
  worktrees: unknown[],
  options?: { proven?: boolean }
): void {
  const validated = readMergedWorktreeRows(worktrees) ?? readHomeWorktreeSummaries(worktrees)
  if (!validated) {
    return
  }
  // Why: a cold-start snapshot seed landing after a live worktree.ps must not erase
  // the proof — or truncate the host-listed rows — the resume check depends on.
  if (options?.proven !== true && readFreshEntry(hostId)?.proven) {
    return
  }
  // Why: Map.set on an existing key does not move it to the end of iteration
  // order. Delete first so the re-inserted key becomes the newest entry,
  // giving us true LRU eviction when the cap is hit.
  cache.delete(hostId)
  // Default false: a caller that has not said where the rows came from must never be taken
  // as grounds for redirecting the user away from a workspace.
  cache.set(hostId, { worktrees: validated, at: Date.now(), proven: options?.proven === true })
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest) {
      cache.delete(oldest)
    }
  }
}

export function getCachedWorktrees(hostId: string): HomeWorktreeSummary[] | null {
  return readValidatedSummaries(hostId, readFreshEntry(hostId))
}

export function getCachedWorkspaceCatalog(hostId: string): Worktree[] | null {
  return readValidatedCatalog(hostId, readFreshEntry(hostId))
}

/** The rows only when the host listed them itself — null whenever absence cannot be trusted,
 *  which is every unproven or expired entry. */
export function getProvenCachedWorktrees(hostId: string): HomeWorktreeSummary[] | null {
  const entry = readFreshEntry(hostId)
  return entry?.proven ? readValidatedSummaries(hostId, entry) : null
}

export function getProvenCachedWorkspaceCatalog(hostId: string): Worktree[] | null {
  const entry = readFreshEntry(hostId)
  return entry?.proven ? readValidatedCatalog(hostId, entry) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readHomeWorktreeSummaries(value: unknown): HomeWorktreeSummary[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const summaries: HomeWorktreeSummary[] = []
  for (const row of value) {
    if (
      !isRecord(row) ||
      'repoId' in row ||
      'linkedPR' in row ||
      'agents' in row ||
      typeof row.worktreeId !== 'string' ||
      typeof row.repo !== 'string' ||
      typeof row.branch !== 'string' ||
      typeof row.displayName !== 'string' ||
      typeof row.liveTerminalCount !== 'number' ||
      !Number.isFinite(row.liveTerminalCount) ||
      (row.status !== undefined &&
        row.status !== 'working' &&
        row.status !== 'active' &&
        row.status !== 'permission' &&
        row.status !== 'done' &&
        row.status !== 'inactive') ||
      (row.isActive !== undefined && typeof row.isActive !== 'boolean') ||
      (row.lastOutputAt !== undefined &&
        (typeof row.lastOutputAt !== 'number' || !Number.isFinite(row.lastOutputAt)))
    ) {
      return null
    }
    summaries.push({
      worktreeId: row.worktreeId,
      repo: row.repo,
      branch: row.branch,
      displayName: row.displayName,
      liveTerminalCount: row.liveTerminalCount,
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.isActive !== undefined ? { isActive: row.isActive } : {}),
      ...(row.lastOutputAt !== undefined ? { lastOutputAt: row.lastOutputAt } : {})
    })
  }
  return summaries
}

function readValidatedSummaries(
  hostId: string,
  entry: CachedWorktrees | null
): HomeWorktreeSummary[] | null {
  if (!entry) {
    return null
  }
  const validated =
    readHomeWorktreeSummaries(entry.worktrees) ??
    readMergedWorktreeRows(entry.worktrees)?.map((row) => ({
      worktreeId: row.worktreeId,
      repo: row.repo,
      branch: row.branch,
      displayName: row.displayName,
      liveTerminalCount: row.liveTerminalCount,
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.isActive !== undefined ? { isActive: row.isActive } : {}),
      ...(row.lastOutputAt !== undefined ? { lastOutputAt: row.lastOutputAt } : {})
    }))
  if (!validated) {
    cache.delete(hostId)
    return null
  }
  return validated
}

function readValidatedCatalog(hostId: string, entry: CachedWorktrees | null): Worktree[] | null {
  if (!entry) {
    return null
  }
  const validated = readMergedWorktreeRows(entry.worktrees)
  if (!validated) {
    cache.delete(hostId)
    return null
  }
  return validated
}

function readFreshEntry(hostId: string): CachedWorktrees | null {
  const entry = cache.get(hostId)
  if (!entry) {
    return null
  }
  if (Date.now() - entry.at > MAX_AGE_MS) {
    cache.delete(hostId)
    return null
  }
  return entry
}
