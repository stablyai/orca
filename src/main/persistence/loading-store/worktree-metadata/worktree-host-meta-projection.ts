import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import { isLocalOnlyWorktreeMetaId } from '../../../../shared/worktree/metadata/local-only-worktree-meta-ids'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import { resolveAliasIdentityKey } from './worktree-identity-metadata'

type WorktreeMetaState = Pick<
  PersistedState,
  'worktreeMeta' | 'worktreeMetaByIdentity' | 'worktreeIdentityAliases'
>

// Local-only IDs cannot belong to remote hosts even when legacy rows lack stamps.
function isExcludedWorktreeMetaRow(
  worktreeId: string,
  executionHostId: ExecutionHostId,
  repoId?: string
): boolean {
  return (
    (repoId !== undefined && getRepoIdFromWorktreeId(worktreeId) !== repoId) ||
    (executionHostId !== LOCAL_EXECUTION_HOST_ID && isLocalOnlyWorktreeMetaId(worktreeId))
  )
}

export function getAllWorktreeMetaForHost(
  runtime: { state: WorktreeMetaState },
  executionHostId: ExecutionHostId,
  repoId?: string
): Record<string, WorktreeMeta> {
  const { worktreeMeta, worktreeIdentityAliases: aliases, worktreeMetaByIdentity } = runtime.state
  const projected: Record<string, WorktreeMeta> = {}
  for (const worktreeId in worktreeMeta) {
    if (
      !Object.hasOwn(worktreeMeta, worktreeId) ||
      isExcludedWorktreeMetaRow(worktreeId, executionHostId, repoId)
    ) {
      continue
    }
    const meta = worktreeMeta[worktreeId]!
    if (!meta.hostId || meta.hostId === executionHostId) {
      projected[worktreeId] = meta
    }
  }
  for (const alias in aliases) {
    if (
      !Object.hasOwn(aliases, alias) ||
      getExecutionHostIdFromWorktreeHostIdentity(alias) !== executionHostId
    ) {
      continue
    }
    const worktreeId = getWorktreeIdFromHostIdentity(alias)
    if (!worktreeId || isExcludedWorktreeMetaRow(worktreeId, executionHostId, repoId)) {
      continue
    }
    const identityKey = resolveAliasIdentityKey(runtime.state, alias)
    const meta = identityKey ? worktreeMetaByIdentity?.[identityKey] : undefined
    if (!meta || (meta.hostId && meta.hostId !== executionHostId)) {
      continue
    }
    projected[worktreeId] =
      meta.hostId === executionHostId ? meta : { ...meta, hostId: executionHostId }
  }
  return projected
}
