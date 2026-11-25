import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { worktreeIdentityKey } from '../../../shared/worktree/id'
import { listClientUnsavedEditorWorktreeIds } from './workspace-cleanup-client-unsaved-editors'
import { scanWorkspaceCleanup } from '../../ipc/workspace-cleanup/workspace-cleanup-scan'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { WorkspaceCleanupCandidate } from '../../../shared/workspace-cleanup/workspace-cleanup'

/** This host's own window persists its unsaved drafts in the session; remote clients report theirs. Keyed by identity so path spellings match. */
export function dirtyEditorWorktreeIds(
  store: RuntimeStore,
  runtime: OrcaRuntimeService
): Set<string> {
  const session = store.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
  const ids = new Set([...listClientUnsavedEditorWorktreeIds(runtime)].map(worktreeIdentityKey))
  for (const [worktreeId, files] of Object.entries(session?.openFilesByWorktree ?? {})) {
    if (files.some((file) => file.dirtyDraftContent !== undefined)) {
      ids.add(worktreeIdentityKey(worktreeId))
    }
  }
  return ids
}

/** The Git evidence for these targets; a failed repo's or another host's row is no evidence here. */
export async function scanTargets(
  store: RuntimeStore,
  runtime: OrcaRuntimeService,
  worktreeIds: string[],
  signal: AbortSignal | undefined,
  inventorySize?: number,
  requireComplete = false
): Promise<Map<string, WorkspaceCleanupCandidate>> {
  const candidates = new Map<string, WorkspaceCleanupCandidate>()
  if (worktreeIds.length === 0) {
    return candidates
  }
  const result = await scanWorkspaceCleanup(
    store,
    { refreshActivity: true },
    {
      signal,
      targetWorktreeIds: worktreeIds,
      // Large real Git inventories can exceed the normal interactive 8-second listing budget.
      listingTimeoutMs: inventorySize ? Math.min(60_000, 8_000 + inventorySize * 40) : undefined,
      getOrchestrationDb: () => runtime.getExistingOrchestrationDb()
    }
  )
  if (requireComplete && result.errors.length) {
    throw new Error(result.errors[0].message)
  }
  const failedRepos = new Set(result.errors.map((error) => error.repoId))
  for (const candidate of result.candidates) {
    if (
      !failedRepos.has(candidate.repoId) &&
      normalizeExecutionHostId(candidate.executionHostId) === LOCAL_EXECUTION_HOST_ID
    ) {
      candidates.set(candidate.worktreeId, candidate)
    }
  }
  return candidates
}
