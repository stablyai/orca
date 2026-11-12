// Which listed workspaces are Orca Cloud workspaces, for worktree.ps rows (the phone draws them as cloud).
// Why cached: ps runs on every list poll, and the runtime store is a file read plus a schema parse.
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { onEphemeralVmRuntimesChanged } from '../../shared/ephemeral-vm-runtime-store-events'
import type { EphemeralVmRuntimeStatus } from '../../shared/ephemeral-vm-runtimes'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'

// A write that skips the change event still shows up within this long.
const MAX_AGE_MS = 15_000

let cached: {
  path: string
  at: number
  byWorkspaceId: Map<string, EphemeralVmRuntimeStatus>
} | null = null
let unsubscribe: (() => void) | null = null

/** Workspace id → the VM state this desktop last recorded, for Orca Cloud workspaces only. */
export function cloudWorkspaceStatusById(
  userDataPath: string,
  now = Date.now()
): ReadonlyMap<string, EphemeralVmRuntimeStatus> {
  if (cached && cached.path === userDataPath && now - cached.at < MAX_AGE_MS) {
    return cached.byWorkspaceId
  }
  unsubscribe ??= onEphemeralVmRuntimesChanged(() => {
    cached = null
  })
  const byWorkspaceId = new Map<string, EphemeralVmRuntimeStatus>()
  const createdAtById = new Map<string, number>()
  try {
    for (const runtime of listEphemeralVmRuntimes(userDataPath)) {
      if (runtime.recipe?.provider !== 'orca-cloud' || !runtime.workspaceId) {
        continue
      }
      // After a rollover a workspace can have an old VM's record too: the newest live VM speaks for
      // it. A cleaned record (that VM is gone) counts only when there is nothing else, so the row is
      // still cloud, as on the desktop's own list (listCloudWorkspaceIds).
      const id = runtime.workspaceId
      const seen = createdAtById.get(id)
      const seenCleaned = byWorkspaceId.get(id) === 'cleaned'
      const cleaned = runtime.status === 'cleaned'
      if (
        seen === undefined ||
        (seenCleaned && !cleaned) ||
        (seenCleaned === cleaned && runtime.createdAt >= seen)
      ) {
        createdAtById.set(runtime.workspaceId, runtime.createdAt)
        byWorkspaceId.set(runtime.workspaceId, runtime.status)
      }
    }
  } catch {
    // An unreadable store marks nothing as cloud; the list itself must still load.
  }
  cached = { path: userDataPath, at: now, byWorkspaceId }
  return byWorkspaceId
}

/** Marks each Orca Cloud workspace's row; other rows are left as they are. */
export function markCloudWorkspaceRows(
  rows: Iterable<Pick<RuntimeWorktreePsSummary, 'worktreeId' | 'orcaCloud'>>,
  statusById: ReadonlyMap<string, EphemeralVmRuntimeStatus>
): void {
  if (statusById.size === 0) {
    return
  }
  for (const row of rows) {
    const status = statusById.get(row.worktreeId)
    if (status) {
      row.orcaCloud = { status }
    }
  }
}

/** Test seam. */
export function resetCloudWorkspaceStatusCache(): void {
  cached = null
  unsubscribe?.()
  unsubscribe = null
}

/** Marks this desktop's Orca Cloud workspaces among worktree.ps rows, read from the profile's runtime store. */
export function markCloudWorkspaceSummaries(
  rows: Iterable<Pick<RuntimeWorktreePsSummary, 'worktreeId' | 'orcaCloud'>>,
  userDataPath: string
): void {
  markCloudWorkspaceRows(rows, cloudWorkspaceStatusById(userDataPath))
}
