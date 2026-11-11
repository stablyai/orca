// What one sync pass does: compares the cloud's manifest with what this computer last wrote and
// what is on disk now. Pure, so the rules (one-way, read-only, bounded) are tested without a VM.

import type {
  CloudSyncLimitsInfo,
  CloudSyncPhase,
  CloudSyncState
} from '../../shared/cloud-sync/cloud-sync-contract'

export type RemoteEntry = { size: number; mtime: number }

/** What this computer wrote for a path: the cloud version it copied and the file it left on disk. */
export type IndexEntry = {
  /** Cloud size and mtime when copied. */
  rs: number
  rm: number
  /** Local size and mtimeMs right after the copy; a difference later means someone wrote here. */
  ls: number
  lm: number
}

export type LocalStat = { size: number; mtimeMs: number } | null

/** Which rows are on for a workspace (this member's choice on this computer). */
export type CloudSyncChoice = { context: boolean; mirror: boolean }

export type SyncLimits = {
  maxFiles: number
  maxBytes: number
  maxFileBytes: number
}

// Decimal units, as the window shows them ("2.0 GB", "100 MB").
export const CONTEXT_LIMITS: SyncLimits = {
  maxFiles: 5_000,
  maxBytes: 250_000_000,
  maxFileBytes: 50_000_000
}
export const MIRROR_LIMITS: SyncLimits = {
  maxFiles: 100_000,
  maxBytes: 2_000_000_000,
  maxFileBytes: 100_000_000
}

export function limitsFor(choice: CloudSyncChoice): SyncLimits {
  return choice.mirror ? MIRROR_LIMITS : CONTEXT_LIMITS
}

export function limitsInfo(choice: CloudSyncChoice): CloudSyncLimitsInfo {
  const limits = limitsFor(choice)
  return { maxBytes: limits.maxBytes, maxFileBytes: limits.maxFileBytes }
}

export function emptySyncState(
  workspaceId: string,
  folder: string,
  choice: CloudSyncChoice,
  phase: CloudSyncPhase
): CloudSyncState {
  return {
    workspaceId,
    choice,
    folder,
    phase,
    files: 0,
    bytes: 0,
    progress: null,
    lastSyncedAt: null,
    editedHere: 0,
    skippedLarge: 0,
    overLimit: 0,
    limits: limitsInfo(choice),
    error: null
  }
}

export type SyncPlan = {
  /** Paths to copy from the cloud, smallest first so the folder fills in quickly. */
  download: string[]
  /** Paths this computer copied earlier that the cloud no longer has (or no longer includes). */
  remove: string[]
  /** Copies someone changed on this computer; kept until the cloud changes the same file. */
  editedHere: string[]
  /** Cloud files over the per-file limit (not copied). */
  skippedLarge: number
  /** Files past the folder's file or byte limit (not copied). */
  overLimit: number
  /** Bytes the folder holds once the plan is applied. */
  totalBytes: number
  totalFiles: number
}

export function isLocalCopyEdited(entry: IndexEntry, local: LocalStat): boolean {
  return (
    local !== null &&
    (local.size !== entry.ls || Math.trunc(local.mtimeMs) !== Math.trunc(entry.lm))
  )
}

export function planSync(input: {
  remote: ReadonlyMap<string, RemoteEntry>
  index: Readonly<Record<string, IndexEntry>>
  local: ReadonlyMap<string, LocalStat>
  limits: SyncLimits
  /** Paths whose remote state is authoritative this pass; others in the index are left alone. */
  scope?: ReadonlySet<string>
}): SyncPlan {
  const { remote, index, local, limits } = input
  const download: string[] = []
  const remove: string[] = []
  const editedHere: string[] = []
  let skippedLarge = 0
  let overLimit = 0
  let totalBytes = 0
  let totalFiles = 0

  // Files already here count toward the limits first, so a full folder never evicts what it has.
  const candidates: [string, RemoteEntry][] = []
  for (const [path, entry] of remote) {
    if (entry.size > limits.maxFileBytes) {
      skippedLarge++
      continue
    }
    const known = index[path]
    const here = local.get(path) ?? null
    if (known && here !== null) {
      const sameCloud = known.rs === entry.size && Math.trunc(known.rm) === Math.trunc(entry.mtime)
      if (sameCloud) {
        if (isLocalCopyEdited(known, here)) {
          editedHere.push(path)
        }
        totalBytes += here.size
        totalFiles++
        continue
      }
    }
    candidates.push([path, entry])
  }
  candidates.sort((a, b) => a[1].size - b[1].size || (a[0] < b[0] ? -1 : 1))
  for (const [path, entry] of candidates) {
    if (totalFiles + 1 > limits.maxFiles || totalBytes + entry.size > limits.maxBytes) {
      overLimit++
      // An older copy of a file that no longer fits stays out of date rather than half-current.
      if (index[path] && (local.get(path) ?? null) !== null) {
        remove.push(path)
      }
      continue
    }
    download.push(path)
    totalBytes += entry.size
    totalFiles++
  }
  for (const path of Object.keys(index)) {
    if (input.scope && !input.scope.has(path)) {
      continue
    }
    if (!remote.has(path) || remote.get(path)!.size > limits.maxFileBytes) {
      remove.push(path)
    }
  }
  return { download, remove, editedHere, skippedLarge, overLimit, totalBytes, totalFiles }
}

/**
 * Safety net for anything the watch missed. The VM's watcher can miss a directory created along
 * with its parent (`mkdir -p .context/shots`), so small folders are re-checked often (a few
 * calls each) and large mirrors less often: 30 ms per file, between 30 s and 10 min, and never
 * more than 5% of the time (a slow pass, e.g. on an image without files.statMany, waits longer).
 */
export const SAFETY_TICK_MS = 30_000
export function safetyIntervalMs(files: number, lastPassMs = 0): number {
  return Math.min(10 * 60_000, Math.max(SAFETY_TICK_MS, files * 30, lastPassMs * 20))
}
