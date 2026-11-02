import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { getLocalPtyProvider } from '../../pty/provider/registry'
import { clearProviderPtyState } from '../../pty/provider/state-cleanup'
import { killAllProcessesForWorktree } from '../../../runtime/worktree-teardown'
import type { Store } from '../../../persistence/loading-store/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../../worktree-removal-repo-owner'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { agentHookServer } from '../../../agent-hooks/server'
import { removeWorktreeMetaRow } from '../../../persistence/host-qualified-worktree-meta'
import { pruneWorktreePRRefreshAliases } from '../../../github/pr-refresh-coordinator'
import {
  dropRemovedWorktreeProcessState,
  pruneRemovedWorktreeSnapshots
} from '../../../worktree-removal-process-cleanup'

export async function stopPtysForDestructiveWorktreeRemoval(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  options: { connectionId?: string; allowUnverifiedStop?: boolean } = {}
): Promise<void> {
  const { connectionId, allowUnverifiedStop } = options
  // This process has no SSH PTY provider and cannot prove remote terminals stopped.
  if (connectionId) {
    throw new Error(`PTY provider unavailable for worktree deletion: ${worktreeId}`)
  }
  const teardownResult = await killAllProcessesForWorktree(worktreeId, {
    runtime,
    // Path-derived IDs repeat across hosts; exact ownership prevents ambiguous selectors or cross-host sweeps.
    resolvedWorktreeId: worktreeId,
    localProvider: getLocalPtyProvider(),
    onPtyStopped: clearProviderPtyState,
    requirePhysicalStop: true,
    // Only explicit Force Delete may waive PTY-stop proof; ordinary force confirmation must remain strict.
    ...(allowUnverifiedStop ? { allowUnverifiedStop: true } : {})
  })
  // Count structured-chat closures even when no PTY stopped so teardown remains observable.
  const structuredStopped = teardownResult.structuredStopped ?? 0
  const total =
    teardownResult.runtimeStopped +
    teardownResult.providerStopped +
    teardownResult.registryStopped +
    structuredStopped
  if (total > 0) {
    console.info(
      `[worktree-teardown] ${worktreeId} killed runtime=${teardownResult.runtimeStopped} provider=${teardownResult.providerStopped} registry=${teardownResult.registryStopped} structured=${structuredStopped}`
    )
  }
}

// Persisted worktree ownership outranks repo fallback; teardown and metadata purge must target the same host.
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
  {
    store,
    runtime,
    entryPoint = 'worktree-removal'
  }: {
    store: Store
    runtime: Pick<OrcaRuntimeService, 'releaseRemovedWorktreeHostSessions'>
    entryPoint?: 'worktree-removal' | 'folder-removal'
  },
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
  // Path-derived IDs are reusable; retire old process state before a new workspace can inherit it.
  removeWorktreeMetaRow(store, worktreeId, hostId)
  // Status retirement is host/pane-scoped, even when another owner keeps the same workspace ID.
  agentHookServer.dropStatusEntriesForRemovedWorktree(worktreeId, hostId ?? persistedHostId)
  if (!preservesSameIdOwner) {
    dropRemovedWorktreeProcessState(worktreeId)
    // Keep Electron-dependent desktop PR cleanup outside the runtime-shared drop.
    pruneWorktreePRRefreshAliases(worktreeId)
    // Paired clients can own browser sessions here; retire them with the workspace.
    runtime.releaseRemovedWorktreeHostSessions(worktreeId, entryPoint)
  }
  pruneRemovedWorktreeSnapshots(
    store.getProfileStorageDirectory(),
    worktreeId,
    hostId,
    snapshotPruneBatchId
  )
}
