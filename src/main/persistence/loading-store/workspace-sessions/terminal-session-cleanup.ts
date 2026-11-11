import { structuralValuesEqualIgnoringUndefined } from '../../../../shared/structural-value-equality'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshotSync,
  type TerminalScrollbackSnapshotStorage
} from '../../../pty/scrollback/terminal-scrollback-snapshots'

// Exclude local-only scrollback: normalization lacks renderer attribution and would strip valid leaf buffers.
const WORKSPACE_SESSION_PATCH_FULL_NORMALIZATION_KEYS = new Set<keyof WorkspaceSessionState>([
  'tabsByWorktree',
  'terminalLayoutsByTabId'
])

export function workspaceSessionPatchNeedsFullNormalization(patch: WorkspaceSessionPatch): boolean {
  return Object.keys(patch).some((key) =>
    WORKSPACE_SESSION_PATCH_FULL_NORMALIZATION_KEYS.has(key as keyof WorkspaceSessionState)
  )
}

/** IPC clones entire supplied maps; reuse equal buckets before doing addressed topology work. */
function reuseTopologyBuckets<T>(
  incoming: Record<string, T> | undefined,
  prior: Record<string, T> | undefined,
  changed: Set<string>
): Record<string, T> | undefined {
  if (incoming === prior) {
    return incoming
  }
  const next = { ...incoming }
  let differs = false
  for (const worktreeId of new Set([...Object.keys(prior ?? {}), ...Object.keys(incoming ?? {})])) {
    if (structuralValuesEqualIgnoringUndefined(incoming?.[worktreeId], prior?.[worktreeId])) {
      if (prior?.[worktreeId] !== undefined) {
        next[worktreeId] = prior[worktreeId]
      }
    } else {
      differs = true
      changed.add(worktreeId)
    }
  }
  return differs ? (incoming === undefined ? undefined : next) : prior
}

export function prepareWorkspaceSessionTopologyPatch(
  patch: WorkspaceSessionPatch,
  prior: WorkspaceSessionState
): { patch: WorkspaceSessionPatch; worktreeIds: ReadonlySet<string> } {
  const worktreeIds = new Set<string>()
  const next = { ...patch }
  if (Object.hasOwn(patch, 'unifiedTabs')) {
    next.unifiedTabs = reuseTopologyBuckets(patch.unifiedTabs, prior.unifiedTabs, worktreeIds)
  }
  if (Object.hasOwn(patch, 'tabGroups')) {
    next.tabGroups = reuseTopologyBuckets(patch.tabGroups, prior.tabGroups, worktreeIds)
  }
  if (Object.hasOwn(patch, 'tabGroupLayouts')) {
    next.tabGroupLayouts = reuseTopologyBuckets(
      patch.tabGroupLayouts,
      prior.tabGroupLayouts,
      worktreeIds
    )
  }
  return { patch: next, worktreeIds }
}

export function deleteRemovedTerminalScrollbackSnapshots(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage,
  /** Pending migration exports retain refs even after their session rows disappear. */
  retainedRefs: ReadonlySet<string> = new Set()
): void {
  if (!prior) {
    return
  }
  const nextRefs = collectTerminalScrollbackSnapshotRefs(next)
  for (const ref of collectTerminalScrollbackSnapshotRefs(prior)) {
    if (!nextRefs.has(ref) && !retainedRefs.has(ref)) {
      deleteTerminalScrollbackSnapshotSync(ref, storage)
    }
  }
}
