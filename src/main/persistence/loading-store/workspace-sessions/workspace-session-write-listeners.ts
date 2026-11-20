import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { StoreRuntimeState } from '../store-runtime-state'
import { refileEditorViews } from './layout-editor-views'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'
import { hasWslMoveFrozenSessions } from '../../moving-wsl-projects/quiescence/wsl-move-scope-guard'
import type { MembershipRewrites } from '../../../runtime/terminal/surface/workspace-session-membership-rewrites'
import { rowShareRef } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-slice'

/** Null means any partition may have changed; absent workspaces mean any workspace of that partition. `refs`: Loader share refs (rows, panes, worktrees) naming more written workspaces. */
export type WorkspaceSessionWriteListener = (
  hostId: ExecutionHostId | null,
  workspaces?: ReadonlySet<string>,
  refs?: ReadonlySet<string>
) => void

/** A writer's own account of the workspaces it changed in one partition. */
export type WrittenWorkspaceScope = {
  workspaces: ReadonlySet<string>
  refs?: ReadonlySet<string>
}

/** Collects the Store's own membership rewrites for a scoped write; undefined for an unscoped one. */
export function membershipRewritesFor(
  written: WrittenWorkspaceScope | undefined
): MembershipRewrites | undefined {
  return written ? { worktreeIds: new Set(), tabIds: new Set(), whole: false } : undefined
}

/** The caller's scope plus the workspaces and terminal tabs the Store's own normalization rewrote; undefined when a rewrite can't be placed. */
export function withStoreRewrites(
  written: WrittenWorkspaceScope | undefined,
  rewrites: MembershipRewrites | undefined,
  rewrittenTabIds: readonly string[] = []
): WrittenWorkspaceScope | undefined {
  if (!written || !rewrites || rewrites.whole) {
    return undefined
  }
  const tabIds = [...rewrites.tabIds, ...rewrittenTabIds]
  if (rewrites.worktreeIds.size === 0 && tabIds.length === 0) {
    return written
  }
  return {
    workspaces: new Set([...written.workspaces, ...rewrites.worktreeIds]),
    refs: new Set([...(written.refs ?? []), ...tabIds.map(rowShareRef)])
  }
}

/** Null means any partition may have changed. */
export type WorkspaceSessionOperationListener = (hostIds: readonly ExecutionHostId[] | null) => void

/** Full saves may contain untracked session edits; an absent host makes all partitions candidates. */
export function notifyWorkspaceSessionWritten(
  runtime: Pick<
    StoreRuntimeState,
    'workspaceSessionWriteListeners' | 'layoutEditorViews' | 'state'
  >,
  dirtyDomains?: readonly string[],
  hostId?: ExecutionHostId,
  workspaces?: ReadonlySet<string>,
  refs?: ReadonlySet<string>
): void {
  if (
    dirtyDomains &&
    !dirtyDomains.some((domain) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widening domain literals permits checking any dirty-domain string.
      (WORKSPACE_SESSION_DOMAINS as readonly string[]).includes(domain)
    )
  ) {
    return
  }
  // Refile views before listeners project the updated session.
  const refiled = refileEditorViews(runtime)
  // A refiled view can move between any of the partition's workspaces; writes re-add WSL-move-frozen workspaces last, reordering the partition beyond the reported ones.
  const scoped =
    workspaces !== undefined &&
    hostId !== undefined &&
    !refiled.has(hostId) &&
    !hasWslMoveFrozenSessions()
  for (const listener of runtime.workspaceSessionWriteListeners) {
    if (scoped) {
      listener(hostId, workspaces, refs)
    } else {
      listener(hostId ?? null)
    }
  }
}

/** Main-owned layouts report each declared partition before announcing mutation completion. */
export function notifyWorkspaceSessionOperationEnded(
  runtime: Pick<
    StoreRuntimeState,
    | 'workspaceSessionWriteListeners'
    | 'workspaceSessionOperationListeners'
    | 'layoutEditorViews'
    | 'state'
  >,
  hostIds: readonly ExecutionHostId[] | null,
  workspaces?: ReadonlyMap<ExecutionHostId, ReadonlySet<string>>
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    notifyWorkspaceSessionWritten(runtime)
    return
  }
  if (hostIds === null) {
    notifyWorkspaceSessionWritten(runtime)
  }
  for (const hostId of hostIds ?? []) {
    notifyWorkspaceSessionWritten(runtime, undefined, hostId, workspaces?.get(hostId))
  }
  for (const listener of runtime.workspaceSessionOperationListeners) {
    // Committed writes must survive a failed observer and still notify the remaining observers.
    try {
      listener(hostIds)
    } catch (error) {
      console.warn('[persistence] workspace-session operation listener failed:', error)
    }
  }
}
