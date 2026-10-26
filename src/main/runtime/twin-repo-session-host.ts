import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../shared/workspace-session-host-field-ownership'
import {
  contestedPartitionHosts,
  pickPrimaryHostForClaims
} from '../../shared/workspace-session-contested-primary-host'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { RuntimeStore } from './runtime-store-contract'

export type CachedWorktreeHost = Pick<Worktree, 'id' | 'hostId' | 'runtimeOwnerEnvironmentId'>

type TwinRepoStore = Pick<RuntimeStore, 'getWorkspaceSession' | 'getWorkspaceSessionHostIds'>

const WORKTREE_KEYED_FIELDS = new Set(
  Object.entries(WORKSPACE_SESSION_FIELD_OWNERSHIP)
    .filter(([, ownership]) => ownership === 'worktreeKeyed')
    .map(([field]) => field)
)

function partitionHoldsWorktree(
  session: WorkspaceSessionState | undefined,
  worktreeId: string
): boolean {
  const workspaceKey = worktreeWorkspaceKey(worktreeId)
  return Object.entries(session ?? {}).some(
    ([field, record]: [string, unknown]) =>
      WORKTREE_KEYED_FIELDS.has(field) &&
      typeof record === 'object' &&
      record !== null &&
      (Object.hasOwn(record, worktreeId) || Object.hasOwn(record, workspaceKey))
  )
}

function cachedWorktreeHostId(worktree: CachedWorktreeHost): ExecutionHostId | null {
  const runtimeOwner = worktree.runtimeOwnerEnvironmentId?.trim()
  return runtimeOwner
    ? toRuntimeExecutionHostId(runtimeOwner)
    : (parseExecutionHostId(worktree.hostId)?.id ?? null)
}

/** Match window save routing for same-id repos: prefer holding partitions unless listing contradicts them, use shared primary for duplicates, then runtime owner or local fallback. */
export function resolveTwinRepoSessionHostId(
  store: TwinRepoStore,
  repos: readonly Repo[],
  repoId: string,
  worktreeId: string,
  cachedWorktrees: readonly CachedWorktreeHost[] | null
): ExecutionHostId | null {
  const twins = contestedPartitionHosts(
    repos.filter((repo) => repo.id === repoId).map((repo) => getRepoExecutionHostId(repo))
  )
  if (twins.length < 2) {
    return null
  }
  const listed = contestedPartitionHosts(
    (cachedWorktrees ?? [])
      .filter((worktree) => worktree.id === worktreeId)
      .map(cachedWorktreeHostId)
      .filter((hostId): hostId is ExecutionHostId => hostId !== null)
  )
  const saved = [
    ...new Set<ExecutionHostId>([
      LOCAL_EXECUTION_HOST_ID,
      ...(store.getWorkspaceSessionHostIds?.() ?? [])
    ])
  ].filter((hostId) => partitionHoldsWorktree(store.getWorkspaceSession?.(hostId), worktreeId))
  if (saved.length > 0) {
    const savedPrimary = pickPrimaryHostForClaims(saved)
    if (listed.length === 0 || listed.includes(savedPrimary)) {
      return savedPrimary
    }
  }
  if (listed.length > 1) {
    return pickPrimaryHostForClaims(listed)
  }
  const runtimeOwners = listed.filter((hostId) => parseExecutionHostId(hostId)?.kind === 'runtime')
  return runtimeOwners.length === 1 ? runtimeOwners[0]! : LOCAL_EXECUTION_HOST_ID
}
