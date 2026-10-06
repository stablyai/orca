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
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'

type CreationEvidenceStore = Pick<Store, 'getRepos' | 'getWorktreeMeta'> &
  Partial<Pick<Store, 'getWorktreeMetaForHost' | 'getAllWorktreeLineage'>>

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
  const lineageById = store.getAllWorktreeLineage?.() ?? {}
  const relatedIds = new Set([target.id])
  for (const lineage of Object.values(lineageById)) {
    if (lineage.parentWorktreeId === target.id) {
      relatedIds.add(lineage.worktreeId)
    }
  }
  // Include ancestors so the existing projection can reject stale edges and cycles.
  for (const id of relatedIds) {
    const parentId = lineageById[id]?.parentWorktreeId
    if (parentId) {
      relatedIds.add(parentId)
    }
  }
  const rows = [target]
  for (const id of relatedIds) {
    if (id === target.id) {
      continue
    }
    const parsedRelated = splitWorktreeIdForFilesystem(id)
    if (parsedRelated?.repoId !== target.repoId) {
      continue
    }
    const relatedMeta = readOwnedMetadata(store, id, routing.repo, routing.hostId, repoOwnerCount)
    if (!relatedMeta) {
      continue
    }
    rows.push(
      mergeWorktree(
        target.repoId,
        {
          path: parsedRelated.worktreePath,
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: false
        },
        { ...relatedMeta, hostId: routing.hostId }
      )
    )
  }
  const projected = projectResolvedWorktreeLineage(rows, lineageById)[0]
  return projected ? { ...projected, git: worktree } : null
}
