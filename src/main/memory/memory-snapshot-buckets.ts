import { basename } from 'node:path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { ChatAgentMemory, SessionMemory } from '../../shared/diagnostics/process-stats-types'
import type { Store } from '../persistence/loading-store/store'
import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import { parseWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { folderWorkspaceRepoId } from '../../shared/folder-workspaces/folder-workspace-worktree'

export type MemorySnapshotStore = Pick<Store, 'getRepo' | 'getWorktreeMeta'> &
  Partial<Pick<Store, 'getFolderWorkspace' | 'getRepos'>> & {
    getProjectGroup?: (id: string) => Pick<ProjectGroup, 'id' | 'name'> | undefined
    getProjectGroups?: () => Pick<ProjectGroup, 'id' | 'name'>[]
  }

const APP_HISTORY_KEY = '__app__'
const HISTORY_CAPACITY = 60
const HISTORY_STALE_MS = 10 * 60 * 1000

type HistoryRing = {
  samples: number[]
  touchedAt: number
}

const historyByKey = new Map<string, HistoryRing>()

export function pushMemoryHistorySample(key: string, memoryBytes: number, now: number): void {
  let ring = historyByKey.get(key)
  if (!ring) {
    ring = { samples: [], touchedAt: now }
    historyByKey.set(key, ring)
  }
  ring.samples.push(memoryBytes)
  if (ring.samples.length > HISTORY_CAPACITY) {
    ring.samples.shift()
  }
  ring.touchedAt = now
}

/** A workspace's terminal-only series, kept once it has had chats; the plain key includes them. */
export function terminalOnlyHistoryKey(worktreeId: string): string {
  return `${worktreeId}\u0000terminals`
}

export function hasMemoryHistory(key: string): boolean {
  return historyByKey.has(key)
}

/** Starts `key` as a copy of `fromKey`'s series, so a new series continues the old one. */
export function seedMemoryHistory(key: string, fromKey: string, now: number): void {
  historyByKey.set(key, {
    samples: [...(historyByKey.get(fromKey)?.samples ?? [])],
    touchedAt: now
  })
}

/** Keeps a series that took no sample this sweep from being swept as stale. */
export function touchMemoryHistory(key: string, now: number): void {
  const ring = historyByKey.get(key)
  if (ring) {
    ring.touchedAt = now
  }
}

export function readMemoryHistory(key: string): number[] {
  const ring = historyByKey.get(key)
  return ring ? [...ring.samples] : []
}

export function sweepStaleMemoryHistory(now: number): void {
  for (const [key, ring] of historyByKey) {
    if (now - ring.touchedAt > HISTORY_STALE_MS) {
      historyByKey.delete(key)
    }
  }
}

export function pushAppMemoryHistory(memoryBytes: number, now: number): void {
  pushMemoryHistorySample(APP_HISTORY_KEY, memoryBytes, now)
}

export function readAppMemoryHistory(): number[] {
  return readMemoryHistory(APP_HISTORY_KEY)
}

export type WorktreeMemoryBucket = {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  cpu: number
  memory: number
  privateMemory: number
  sessions: SessionMemory[]
  /** Created with the first chat, so a terminal-only workspace sends no empty list. */
  chats?: ChatAgentMemory[]
}

/** Project-group names read once per snapshot, not once per folder bucket. */
export type ProjectGroupNameLookup = (projectGroupId: string) => string | undefined

export function createProjectGroupNameLookup(store: MemorySnapshotStore): ProjectGroupNameLookup {
  const { getProjectGroup } = store
  if (getProjectGroup) {
    // Keyed, so a sample with one folder workspace never copies and sorts every group.
    const names = new Map<string, string | undefined>()
    return (projectGroupId) => {
      if (!names.has(projectGroupId)) {
        names.set(projectGroupId, getProjectGroup.call(store, projectGroupId)?.name)
      }
      return names.get(projectGroupId)
    }
  }
  let names: Map<string, string | undefined> | null = null
  return (projectGroupId) => {
    // SAFETY: Missing optional capabilities keep the original direct-call failure.
    names ??= new Map(store.getProjectGroups!().map((group) => [group.id, group.name]))
    return names.get(projectGroupId)
  }
}

/** Repo display names read once per repo per snapshot; the store's repo lookup scans the catalog. */
export type RepoNameLookup = (repoId: string) => string | undefined

export function createRepoNameLookup(store: MemorySnapshotStore): RepoNameLookup {
  // getRepo scans the catalog, so a sample spanning many projects indexes it once instead.
  let byId: Map<string, string | undefined> | undefined
  const names = new Map<string, string | undefined>()
  return (repoId) => {
    if (store.getRepos) {
      byId ??= new Map(
        store.getRepos().map((repo) => [repo.id, repo.displayName?.trim() || undefined])
      )
      return byId.get(repoId)
    }
    if (!names.has(repoId)) {
      names.set(repoId, store.getRepo(repoId)?.displayName?.trim() || undefined)
    }
    return names.get(repoId)
  }
}

export function resolveWorktreeMemoryNames(
  worktreeId: string,
  store: MemorySnapshotStore,
  projectGroupName: ProjectGroupNameLookup = createProjectGroupNameLookup(store),
  repoName: RepoNameLookup = createRepoNameLookup(store)
): {
  worktreeName: string
  repoId: string
  repoName: string
} {
  const scope = parseWorkspaceKey(worktreeId)
  // SAFETY: Missing optional capabilities keep the original direct-call failure.
  const folder =
    scope?.type === 'folder' ? store.getFolderWorkspace!(scope.folderWorkspaceId) : null
  if (folder) {
    // Why: names only; building the full worktree record would normalize every attachment per sample.
    return {
      worktreeName: folder.name,
      repoId: folderWorkspaceRepoId(folder.projectGroupId),
      repoName: projectGroupName(folder.projectGroupId)?.trim() || folder.name
    }
  }
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const repoId = parsed?.repoId ?? worktreeId
  const worktreePath = parsed?.worktreePath ?? ''
  const fallbackName = worktreePath ? basename(worktreePath) : worktreeId
  const meta = store.getWorktreeMeta(worktreeId)

  return {
    worktreeName: meta?.displayName?.trim() || fallbackName,
    repoId,
    repoName: repoName(repoId) || repoId || 'Unknown Repo'
  }
}

export function createEmptyWorktreeMemoryBucket(
  worktreeId: string,
  worktreeName: string,
  repoId: string,
  repoName: string
): WorktreeMemoryBucket {
  return {
    worktreeId,
    worktreeName,
    repoId,
    repoName,
    cpu: 0,
    memory: 0,
    privateMemory: 0,
    sessions: []
  }
}
