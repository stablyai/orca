import {
  getSavedWorktreeLineage,
  resolveWorktreeLineageParents,
  lineageStoreKeyForRow,
  projectResolvedWorktreeLineage,
  mergeWorkspaceLineageRecords
} from '../shared/resolved-worktree-lineage'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../shared/worktree/id'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import type { Worktree } from '../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../shared/folder-workspace-worktree'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import type { RuntimeStore } from './runtime/runtime-store-contract'

export type LineageStore = Partial<
  Pick<
    RuntimeStore,
    | 'getRepos'
    | 'getAllWorktreeMeta'
    | 'getWorktreeLineageMetadata'
    | 'getAllWorktreeLineage'
    | 'getAllWorkspaceLineage'
    | 'getFolderWorkspaces'
  >
>
function readStoredWorktreeLineage(store: LineageStore) {
  return mergeWorkspaceLineageRecords(
    Object.fromEntries(
      Object.entries(store.getAllWorktreeLineage?.() ?? {}).map(([id, edge]) => [id, { ...edge }])
    ),
    Object.fromEntries(
      Object.entries(store.getAllWorkspaceLineage?.() ?? {}).map(([id, edge]) => [id, { ...edge }])
    )
  )
}

export function readWorktreeLineageCorpus(
  store: LineageStore,
  lineageById = readStoredWorktreeLineage(store)
) {
  const rawMetadata = Object.fromEntries(
    Object.entries(store.getAllWorktreeMeta?.() ?? {}).map(([id, meta]) => [id, { ...meta }])
  )
  const metadata = (
    store.getWorktreeLineageMetadata?.() ??
    Object.entries(rawMetadata).map(([id, meta]) => ({ id, meta }))
  ).map(({ id, meta }) => ({ id, meta: { ...meta } }))
  const repos = store.getRepos?.() ?? []
  const repoHosts = new Map(repos.map((repo) => [repo, getRepoExecutionHostId(repo)]))
  const reposById = new Map<string, typeof repos>()
  for (const repo of repos) {
    const group = reposById.get(repo.id) ?? []
    group.push(repo)
    reposById.set(repo.id, group)
  }
  const hostsById = new Map<string, Set<string>>()
  for (const { id, meta } of metadata) {
    if (meta.hostId) {
      const hosts = hostsById.get(id) ?? new Set<string>()
      hosts.add(meta.hostId)
      hostsById.set(id, hosts)
    }
  }
  const folders = store.getFolderWorkspaces?.().map(folderWorkspaceToWorktree) ?? []
  const currentHost = (repoId: string, hostId: Worktree['hostId']) => {
    const owners = reposById.get(repoId) ?? []
    return hostId ?? (owners.length === 1 ? repoHosts.get(owners[0]) : undefined)
  }
  const currentRow = <T extends Worktree>(row: T): T => {
    if (lineageStoreKeyForRow(row)) {
      return row
    }
    return {
      ...row,
      hostId: currentHost(row.repoId, row.hostId),
      savedLineage: undefined,
      lineage: null
    }
  }
  let rows: Worktree[] | undefined
  let members: Map<string, string | undefined> | undefined
  let adjacent: Map<string, Set<string>> | undefined
  return {
    lineageById,
    rawMetadata,
    repos,
    reposById,
    folders,
    get rows() {
      return (rows ??= [
        ...new Map(
          [
            ...metadata.map(({ id, meta }) => {
              const merged = mergeWorktree(
                getRepoIdFromWorktreeId(id),
                {
                  path: splitWorktreeId(id)?.worktreePath ?? '',
                  head: '',
                  branch: '',
                  isBare: false,
                  isMainWorktree: false
                },
                meta
              )
              return {
                ...merged,
                id,
                hostId: currentHost(getRepoIdFromWorktreeId(id), meta.hostId)
              }
            }),
            ...folders
          ].map((row) => [getWorktreeHostIdentity(row), row])
        ).values()
      ])
    },
    currentRow,
    hasCurrent(row: Worktree) {
      members ??= new Map([
        ...metadata.map(({ id, meta }) => {
          return [
            getWorktreeHostIdentity({
              id,
              hostId: currentHost(getRepoIdFromWorktreeId(id), meta.hostId)
            }),
            meta.instanceId
          ] as const
        }),
        ...folders.map((folder) => [getWorktreeHostIdentity(folder), folder.instanceId] as const)
      ])
      const key = getWorktreeHostIdentity(currentRow(row))
      return members.has(key) && members.get(key) === row.instanceId
    },
    edgeOf: (row: Worktree) => getSavedWorktreeLineage(currentRow(row), lineageById, rawMetadata),
    project<T extends Worktree>(supplied: readonly T[]) {
      return projectResolvedWorktreeLineage(
        supplied.map(currentRow),
        lineageById,
        this.rows.map(currentRow),
        rawMetadata
      )
    },
    relatedRepos(seeds: readonly string[]) {
      const ids = this.relatedIds(seeds)
      const byRepo = new Map<string, Set<string>>()
      for (const id of ids) {
        const repoId = getRepoIdFromWorktreeId(id)
        const hosts = byRepo.get(repoId) ?? new Set<string>()
        for (const host of hostsById.get(id) ?? []) {
          hosts.add(host)
        }
        byRepo.set(repoId, hosts)
      }
      return [...byRepo].flatMap(([id, hosts]) =>
        (reposById.get(id) ?? []).filter(
          (repo) => hosts.size === 0 || hosts.has(getRepoExecutionHostId(repo))
        )
      )
    },
    relatedIds(seeds: readonly string[]) {
      if (!adjacent) {
        const links = new Map<string, Set<string>>()
        adjacent = links
        const connect = (a: string, b: string) => {
          const peers = links.get(a) ?? new Set<string>()
          peers.add(b)
          links.set(a, peers)
        }
        const parents = resolveWorktreeLineageParents(
          this.rows,
          this.edgeOf,
          undefined,
          'saved-walk'
        )
        const selected = new Set<string>()
        for (const [child, parent] of parents) {
          if (this.edgeOf(child)?.parentStore === 'external') {
            continue
          }
          selected.add(child.id)
          connect(child.id, parent.id)
          connect(parent.id, child.id)
        }
        // Missing metadata still needs a bounded raw-locator scan, never for external intent.
        for (const edge of Object.values(lineageById)) {
          if (edge.parentStore || selected.has(edge.worktreeId)) {
            continue
          }
          connect(edge.worktreeId, edge.parentWorktreeId)
          connect(edge.parentWorktreeId, edge.worktreeId)
        }
      }
      const links = adjacent
      const ids = new Set(seeds.filter((id) => links.has(id)))
      for (const id of ids) {
        for (const peer of links.get(id) ?? []) {
          ids.add(peer)
        }
      }
      return ids
    }
  }
}

/** Current own-store facts supersede cached publication carriers at an action boundary. */
export function projectCurrentStoreWorktreeLineage<T extends Worktree>(
  store: LineageStore,
  rows: readonly T[]
) {
  const lineageById = readStoredWorktreeLineage(store)
  if (
    Object.keys(lineageById).length === 0 &&
    rows.every((row) => row.hostId !== undefined && !row.savedLineage && !row.lineage)
  ) {
    return rows.map((row) => ({
      ...row,
      savedLineage: null,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    }))
  }
  return readWorktreeLineageCorpus(store, lineageById).project(rows)
}
