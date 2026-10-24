import type { Store } from '../persistence'
import type { Worktree } from '../../shared/worktree/types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'
import { isWorktreeMetaOwnedByRepo } from '../worktree-metadata-ownership'
import { isFolderRepo } from '../../shared/repo-kind'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Repo } from '../../shared/repo-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import { projectCurrentStoreWorktreeLineage } from '../worktree-lineage-candidates'
import type { LineageStore } from '../worktree-lineage-candidates'

type CreationEvidenceStore = Pick<Store, 'getRepos' | 'getWorktreeMeta'> &
  Partial<Pick<Store, 'getWorktreeMetaForHost'>> &
  LineageStore

function readOwnedMetadata(
  store: CreationEvidenceStore,
  worktreeId: string,
  repo: Repo,
  hostId: ExecutionHostId,
  repoOwnerCount: number
): WorktreeMeta | undefined {
  const qualifiedMeta = readWorktreeMetaForHost(store, worktreeId, hostId)
  const meta = qualifiedMeta ?? store.getWorktreeMeta(worktreeId)
  return meta &&
    (!meta.hostId || meta.hostId === hostId) &&
    (qualifiedMeta || isWorktreeMetaOwnedByRepo(repo, meta, repoOwnerCount))
    ? meta
    : undefined
}

/** Reuse same-operation creation evidence only while its persisted instance and host still agree. */
export function resolveCreatedWorktreeTerminalTarget(
  store: CreationEvidenceStore | null | undefined,
  selector: string,
  worktree: Worktree | undefined
): ResolvedWorktree | null {
  if (!store || !worktree || selector !== `id:${worktree.id}` || !worktree.instanceId) {
    return null
  }
  const parsed = splitWorktreeIdForFilesystem(worktree.id)
  if (parsed?.repoId !== worktree.repoId || parsed.worktreePath !== worktree.path) {
    return null
  }
  const repos = store.getRepos()
  const routing = resolveWorktreeHostRouting(repos, worktree)
  if (routing.kind !== 'resolved' || !routing.repo || isFolderRepo(routing.repo)) {
    return null
  }
  const repoOwnerCount = repos.filter((repo) => repo.id === worktree.repoId).length
  const meta = readOwnedMetadata(store, worktree.id, routing.repo, routing.hostId, repoOwnerCount)
  if (meta?.instanceId !== worktree.instanceId) {
    return null
  }
  const target = mergeWorktree(
    worktree.repoId,
    worktree,
    { ...meta, hostId: routing.hostId },
    routing.repo.displayName
  )
  const projected = projectCurrentStoreWorktreeLineage(store, [target])[0]
  return projected ? { ...projected, git: worktree } : null
}
