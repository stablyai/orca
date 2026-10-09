import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import {
  canonicalWorktreeIdentity,
  createWorktreeIdentity,
  type WorktreeIdentity
} from '../../shared/worktree/identity'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import type { RuntimeStore } from './runtime-store-contract'
import { resolveWorktreeLaunchHost } from './worktree-launch-host-repo'

/** Null refuses a known owner; undefined retains an unqualified legacy scope. */
export function resolveRuntimeWorkspaceSessionOwner(
  store: RuntimeStore | null,
  worktreeId: string,
  requested?: WorktreeIdentity
): WorktreeIdentity | null | undefined {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!store || !parsed) {
    return requested ? null : undefined
  }
  const repos = (store.getRepos?.() ?? []).filter((repo) => repo.id === parsed.repoId)
  const resolution = resolveWorktreeLaunchHost(repos, {
    repoId: parsed.repoId,
    hostId: requested?.executionHostId
  })
  if (resolution.kind !== 'resolved') {
    return null
  }
  const repo = resolution.repo
  if (!repo) {
    return requested ? null : undefined
  }
  const hostId = getRepoExecutionHostId(repo)
  if (requested && parseExecutionHostId(requested.executionHostId)?.id !== hostId) {
    return null
  }
  if (repos.filter((candidate) => getRepoExecutionHostId(candidate) === hostId).length !== 1) {
    return null
  }
  const meta =
    readWorktreeMetaForHost(store, worktreeId, hostId) ??
    (repos.length === 1 ? store.getWorktreeMeta?.(worktreeId) : undefined)
  const instanceId = requested?.instanceId ?? meta?.instanceId
  if (!instanceId) {
    return requested ? null : undefined
  }
  const owner = createWorktreeIdentity({ worktreeId, executionHostId: hostId, instanceId })
  if (
    (requested && requested.key !== canonicalWorktreeIdentity({ worktreeId, ...requested })) ||
    (meta?.hostId && meta.hostId !== hostId) ||
    (meta?.instanceId !== undefined && meta.instanceId !== instanceId) ||
    (store.isCurrentWorktreeMetadata
      ? !store.isCurrentWorktreeMetadata(worktreeId, { executionHostId: hostId, instanceId })
      : requested !== undefined && meta?.instanceId !== instanceId)
  ) {
    return null
  }
  return owner
}

export function admitRuntimeWorkspaceSessionSnapshot(
  store: RuntimeStore | null,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing?: RuntimeMobileSessionTabsSnapshot
): RuntimeMobileSessionTabsSnapshot | null {
  const owner = resolveRuntimeWorkspaceSessionOwner(
    store,
    snapshot.worktree,
    snapshot.worktreeIdentity
  )
  if (
    owner === null ||
    (!owner && existing?.worktreeIdentity !== undefined) ||
    (owner && snapshot.worktreeInstanceId && owner.instanceId !== snapshot.worktreeInstanceId)
  ) {
    return null
  }
  return owner
    ? { ...snapshot, worktreeIdentity: owner, worktreeInstanceId: owner.instanceId }
    : snapshot
}

export function requireRuntimeWorkspaceSessionOwner(
  store: RuntimeStore | null,
  worktreeId: string,
  requested?: WorktreeIdentity
): WorktreeIdentity | undefined {
  const owner = resolveRuntimeWorkspaceSessionOwner(store, worktreeId, requested)
  if (owner === null) {
    throw new Error(requested ? 'selector_not_found' : 'selector_ambiguous')
  }
  return owner
}

export function runtimeSessionSnapshotsShareOwner(
  first: Pick<
    RuntimeMobileSessionTabsSnapshot,
    'worktree' | 'worktreeIdentity' | 'worktreeInstanceId'
  >,
  second: Pick<
    RuntimeMobileSessionTabsSnapshot,
    'worktree' | 'worktreeIdentity' | 'worktreeInstanceId'
  >
): boolean {
  return (
    first.worktree === second.worktree &&
    first.worktreeIdentity?.key === second.worktreeIdentity?.key &&
    !(
      first.worktreeInstanceId &&
      second.worktreeInstanceId &&
      first.worktreeInstanceId !== second.worktreeInstanceId
    )
  )
}
