// Paired module for OrcaRuntimeWithResolveWorktreeRemovalTarget's removal purge
// (kept under the max-lines gate; see the @ts-nocheck note on that class file).
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import type { ExecutionHostId, ExecutionHostScope } from '../../shared/execution-host'
import { splitWorktreeId } from '../../shared/worktree/id'
import { invalidateAuthorizedRootsCacheForRepo } from '../ipc/filesystem-auth'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../worktree-removal-repo-owner'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import { deleteWorktreeHistoryDir } from '../terminal-history-deletion'
import { closeClientHostedBrowserPagesForWorktree } from './worktree-browser-client-page-close'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { dropOrcaCreatedCodexPretrustForRemovedWorktree } from './worktree-removal-codex-pretrust-cleanup'

/** The runtime members the removal purge touches, decoupled from the class chain. */
type WorktreeRemovalHostStateRuntime = {
  getRuntimeId(): string
  clearOptimisticReconcileToken(worktreeId: string): void
  invalidateResolvedWorktreeCache(): void
  invalidateWorktreeScanCacheForRepo(repoId: string): void
  acceptedRendererMobileSnapshotByWorktree: Map<string, { publicationEpoch: string }>
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  pairedRendererSessionOwnedPtyIds: Set<string>
  ptysById: ReadonlyMap<string, { worktreeId?: string }>
  rendererGeneration: string | null
  removedMobileSessionWorktreeIds: Map<
    string,
    { removedPublicationEpoch?: string; rejectedPublication?: boolean }
  >
  mobileSessionTabsAgentStatusHeartbeat: { removeWorktree(worktreeId: string): void }
  cancelScheduledMobileSessionTabsChanged(worktreeId: string): void
  notifyMobileSessionTabsRemoved(worktreeId: string): void
  offscreenBrowserBackend: BrowserBackend | null
  agentBrowserBridge: Pick<AgentBrowserBridge, 'tabList'> | null
  dropAgentStatusForRemovedWorktreeFn:
    | ((worktreeId: string, host?: ExecutionHostScope) => void)
    | null
}

// Why: headless offscreen browser pages are main-process BrowserWindows that
// outlive a worktree unless explicitly closed — removing a worktree without
// closing its open panes leaks the windows for the life of the serve process.
function closeHeadlessBrowserPagesForWorktree(
  runtime: WorktreeRemovalHostStateRuntime,
  worktreeId: string
): void {
  if (!runtime.offscreenBrowserBackend || !runtime.agentBrowserBridge) {
    return
  }
  for (const tab of runtime.agentBrowserBridge.tabList(worktreeId).tabs) {
    void runtime.offscreenBrowserBackend.closeTab(tab.browserPageId).catch(() => {})
  }
}

/** Host state every removal path drops once Git has let go of the checkout. */
export async function purgeRemovedWorktreeHostState(
  runtime: WorktreeRemovalHostStateRuntime,
  store: RuntimeStore,
  worktreeId: string,
  repoId: string,
  removalHostId?: ExecutionHostId
): Promise<void> {
  runtime.clearOptimisticReconcileToken(worktreeId)
  const metadataAndHistory = removeRuntimeWorktreeMetadataAndHistory(
    runtime,
    store,
    worktreeId,
    removalHostId
  )
  runtime.invalidateResolvedWorktreeCache()
  runtime.invalidateWorktreeScanCacheForRepo(repoId)
  // Why scoped: upstream narrowed the invalidation to the removed repo (#23952 follow-up),
  // so a stale entry for one repo no longer evicts every other repo's cached roots.
  const fullStore =
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scoped invalidation only reads store.getRepos() (registered-worktree-roots-cache synchronizeOwners), which RuntimeStore already carries.
    store as unknown as Parameters<typeof invalidateAuthorizedRootsCacheForRepo>[0]
  invalidateAuthorizedRootsCacheForRepo(fullStore, repoId)
  await metadataAndHistory
}

export async function removeRuntimeWorktreeMetadataAndHistory(
  runtime: WorktreeRemovalHostStateRuntime,
  store: RuntimeStore,
  worktreeId: string,
  hostId?: ExecutionHostId
): Promise<void> {
  const persistedHostId = store.getWorktreeMeta(worktreeId)?.hostId
  const repoId = splitWorktreeId(worktreeId)?.repoId
  const preservesSameIdOwner = Boolean(
    hostId &&
    ((persistedHostId && persistedHostId !== hostId) ||
      (repoId && hasWorktreeRemovalRepoOwnerOnOtherHost(store, repoId, hostId)))
  )
  const acceptedRendererSnapshot = runtime.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
  const storedSnapshot = runtime.mobileSessionTabsByWorktree.get(worktreeId)
  if (hostId) {
    store.removeWorktreeMeta(worktreeId, hostId)
  } else {
    store.removeWorktreeMeta(worktreeId)
  }
  // Why outside the same-id gate: retirement is per host and per pane, so a surviving owner keeps its own.
  runtime.dropAgentStatusForRemovedWorktreeFn?.(worktreeId, hostId ?? persistedHostId)
  if (!preservesSameIdOwner) {
    // Why: worktree IDs are path-derived and can be recreated; a stale Codex
    // pretrust entry must not pre-trust the next occupant of the path.
    const pretrustDrop = dropOrcaCreatedCodexPretrustForRemovedWorktree(worktreeId)
    // A paired PTY can outlive the delete acknowledgement; it must not be
    // rescued into a newly-created occupant of the same path-derived ID.
    for (const ptyId of runtime.pairedRendererSessionOwnedPtyIds) {
      const ptyWorktreeId = runtime.ptysById.get(ptyId)?.worktreeId
      if (ptyWorktreeId && runtimeWorktreeIdsEqual(ptyWorktreeId, worktreeId)) {
        runtime.pairedRendererSessionOwnedPtyIds.delete(ptyId)
      }
    }
    const removedPublicationEpoch =
      acceptedRendererSnapshot?.publicationEpoch ??
      storedSnapshot?.publicationEpoch ??
      runtime.rendererGeneration ??
      undefined
    runtime.removedMobileSessionWorktreeIds.set(
      worktreeId,
      removedPublicationEpoch ? { removedPublicationEpoch } : {}
    )
    runtime.mobileSessionTabsByWorktree.delete(worktreeId)
    runtime.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
    runtime.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
    runtime.cancelScheduledMobileSessionTabsChanged(worktreeId)
    runtime.notifyMobileSessionTabsRemoved(worktreeId)
    advertisedUrlWatcher.forgetWorktree(worktreeId)
    deleteWorktreeHistoryDir(worktreeId)
    closeHeadlessBrowserPagesForWorktree(runtime, worktreeId)
    closeClientHostedBrowserPagesForWorktree(runtime, worktreeId)
    // Awaited last so every in-memory invalidation above stays synchronous,
    // while callers holding the returned promise still wait for the entry
    // deletion (failures degrade inside the helper, never fail the removal).
    await pretrustDrop
  }
}
