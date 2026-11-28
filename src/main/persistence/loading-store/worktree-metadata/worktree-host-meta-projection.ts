import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { WORKTREE_ID_SEPARATOR } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { isLocalOnlyWorktreeMetaId } from '../../../../shared/worktree/metadata/local-only-worktree-meta-ids'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import { resolveAliasIdentityKey } from './worktree-identity-alias'

type WorktreeMetaState = Pick<
  PersistedState,
  'worktreeMeta' | 'worktreeMetaByIdentity' | 'worktreeIdentityAliases'
>

function matchesRepoId(worktreeId: string, repoId: string, repoPrefix: string): boolean {
  return worktreeId.startsWith(repoPrefix) || worktreeId === repoId
}

export function getAllWorktreeMetaForHost(
  runtime: { state: WorktreeMetaState },
  executionHostId: ExecutionHostId,
  repoId?: string
): Record<string, WorktreeMeta> {
  const { worktreeMeta, worktreeIdentityAliases: aliases, worktreeMetaByIdentity } = runtime.state
  const projected: Record<string, WorktreeMeta> = {}
  const isRemoteHost = executionHostId !== LOCAL_EXECUTION_HOST_ID
  const repoPrefix = repoId !== undefined ? `${repoId}${WORKTREE_ID_SEPARATOR}` : undefined
  for (const worktreeId in worktreeMeta) {
    if (
      !Object.hasOwn(worktreeMeta, worktreeId) ||
      (repoId !== undefined && !matchesRepoId(worktreeId, repoId, repoPrefix!)) ||
      (isRemoteHost && isLocalOnlyWorktreeMetaId(worktreeId))
    ) {
      continue
    }
    const meta = worktreeMeta[worktreeId]!
    if (!meta.hostId || meta.hostId === executionHostId) {
      projected[worktreeId] = meta
    }
  }
  if (!aliases) {
    return projected
  }
  const hostPrefix = composeWorktreeHostIdentity(executionHostId, '')
  const hostRepoPrefix = repoPrefix !== undefined ? `${hostPrefix}${repoPrefix}` : undefined
  const hostExactRepo = repoId !== undefined ? `${hostPrefix}${repoId}` : undefined
  for (const alias in aliases) {
    if (!Object.hasOwn(aliases, alias)) {
      continue
    }
    if (hostRepoPrefix !== undefined) {
      if (!alias.startsWith(hostRepoPrefix) && alias !== hostExactRepo) {
        continue
      }
    } else if (!alias.startsWith(hostPrefix)) {
      continue
    }
    const worktreeId = alias.slice(hostPrefix.length)
    if (!worktreeId || (isRemoteHost && isLocalOnlyWorktreeMetaId(worktreeId))) {
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
