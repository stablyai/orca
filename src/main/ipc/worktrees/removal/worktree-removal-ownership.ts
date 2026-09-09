import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { getSshPtyProvider, getLocalPtyProvider, clearProviderPtyState } from '../../pty'
import { killAllProcessesForWorktree } from '../../../runtime/worktree-teardown'
import type { Store } from '../../../persistence/loading-store/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../../worktree-removal-repo-owner'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { advertisedUrlWatcher } from '../../../ports/advertised-url-watcher'
import { localhostWorktreeLabelProxy } from '../../../localhost-worktree-label-proxy'
import { deleteWorktreeHistoryDir } from '../../../terminal-history-deletion'
import { pruneWorktreePRRefreshAliases } from '../../../github/pr-refresh-coordinator'
import { recordWorkspaceCleanupRemovalSnapshotPrune } from '../../../workspace-cleanup-removal-snapshot-prune'
import { pruneWorkspaceCleanupScanSnapshot } from '../../../workspace-cleanup-scan-snapshot'
import { pruneWorkspaceSpaceAnalysisSnapshot } from '../../../workspace-space-analysis-snapshot'

export async function stopPtysForDestructiveWorktreeRemoval(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  options: { connectionId?: string; allowUnverifiedStop?: boolean } = {}
): Promise<void> {
  const { connectionId, allowUnverifiedStop } = options
  const provider = connectionId ? getSshPtyProvider(connectionId) : getLocalPtyProvider()
  if (!provider) {
    throw new Error(`PTY provider unavailable for worktree deletion: ${worktreeId}`)
  }
  const teardownResult = await killAllProcessesForWorktree(worktreeId, {
    runtime,
    // Why: `repoId::path` ids repeat across hosts, so an unfenced sweep stops a same-id
    // workspace's terminals on another connection — and the selector lookup this replaces
    // throws `selector_ambiguous` the moment two hosts own the id.
    resolvedWorktreeId: worktreeId,
    ...(connectionId ? { resolvedConnectionId: connectionId } : {}),
    localProvider: provider,
    onPtyStopped: clearProviderPtyState,
    requirePhysicalStop: true,
    // Why (#11960): set only by an explicit Force Delete, never by the ordinary
    // confirmation — otherwise the gate would be off on the primary delete path.
    ...(allowUnverifiedStop ? { allowUnverifiedStop: true } : {}),
    ...(connectionId ? { includeLocalRegistry: false } : {})
  })
  const total =
    teardownResult.runtimeStopped + teardownResult.providerStopped + teardownResult.registryStopped
  if (total > 0) {
    console.info(
      `[worktree-teardown] ${worktreeId} killed runtime=${teardownResult.runtimeStopped} provider=${teardownResult.providerStopped} registry=${teardownResult.registryStopped}`
    )
  }
}

// Why: the worktree's own persisted host outranks the repo fallback; teardown and metadata purge must resolve the same owner
// or the purge lands on the local partition while the SSH/runtime one keeps the workspace's tabs forever.
export function resolveWorktreeRemovalOwnerHostId(
  store: Store,
  worktreeId: string,
  repo: Repo | undefined,
  fallbackHostId?: ExecutionHostId
): ExecutionHostId | undefined {
  return (
    fallbackHostId ??
    (repo ? getRepoExecutionHostId(repo) : store.getWorktreeMeta(worktreeId)?.hostId)
  )
}

export function removeWorktreeMetadataAndTransientState(
  store: Store,
  worktreeId: string,
  hostId?: ExecutionHostId,
  snapshotPruneBatchId?: string
): void {
  const persistedHostId = store.getWorktreeMeta(worktreeId)?.hostId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const preservesSameIdOwner = Boolean(
    hostId &&
    ((persistedHostId && persistedHostId !== hostId) ||
      hasWorktreeRemovalRepoOwnerOnOtherHost(store, repoId, hostId))
  )
  // Why: worktree IDs are path-derived and reusable; drop process-local caches before the same ID can map to a new workspace.
  if (hostId) {
    store.removeWorktreeMeta(worktreeId, hostId)
  } else {
    store.removeWorktreeMeta(worktreeId)
  }
  if (!preservesSameIdOwner) {
    advertisedUrlWatcher.forgetWorktree(worktreeId)
    // Why: drop this worktree's localhost label routes so they don't accumulate in the proxy's route maps all session.
    localhostWorktreeLabelProxy.unregisterWorktree(worktreeId)
    // Why: schedule async history tree removal — never recursive-rmSync on the delete critical path.
    deleteWorktreeHistoryDir(worktreeId)
    // Why: release the removed worktree's PR-refresh aliases so coalesced queue entries don't retain it all session (memory creep).
    pruneWorktreePRRefreshAliases(worktreeId)
  }
  // Why: removed workspaces must never resurrect from the persisted cleanup/space scan snapshots.
  const snapshotDirectory = store.getProfileStorageDirectory()
  if (snapshotPruneBatchId) {
    recordWorkspaceCleanupRemovalSnapshotPrune(snapshotDirectory, {
      batchId: snapshotPruneBatchId,
      worktreeId,
      executionHostId: hostId
    })
    return
  }
  void pruneWorkspaceCleanupScanSnapshot(snapshotDirectory, worktreeId, hostId)
  void pruneWorkspaceSpaceAnalysisSnapshot(snapshotDirectory, worktreeId, hostId)
}
