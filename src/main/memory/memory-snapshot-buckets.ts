import { basename } from 'node:path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { ChatAgentMemory, SessionMemory } from '../../shared/diagnostics/process-stats-types'
import type { Store } from '../persistence/loading-store/store'
import { parseWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { folderWorkspaceRepoId } from '../../shared/folder-workspaces/folder-workspace-worktree'

export type MemorySnapshotStore = Pick<Store, 'getRepo' | 'getWorktreeMeta'> &
  Partial<Pick<Store, 'getFolderWorkspace'>> & {
    getProjectGroups?: () => Pick<ReturnType<Store['getProjectGroups']>[number], 'id' | 'name'>[]
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
  chats: ChatAgentMemory[]
}

/** Project-group names read once per snapshot, not once per folder bucket. */
export type ProjectGroupNameLookup = (projectGroupId: string) => string | undefined

export function createProjectGroupNameLookup(store: MemorySnapshotStore): ProjectGroupNameLookup {
  let names: Map<string, string | undefined> | null = null
  return (projectGroupId) => {
    // SAFETY: Missing optional capabilities keep the original direct-call failure.
    names ??= new Map(store.getProjectGroups!().map((group) => [group.id, group.name]))
    return names.get(projectGroupId)
  }
}

export function resolveWorktreeMemoryNames(
  worktreeId: string,
  store: MemorySnapshotStore,
  projectGroupName: ProjectGroupNameLookup = createProjectGroupNameLookup(store)
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
  const repo = store.getRepo(repoId)

  return {
    worktreeName: meta?.displayName?.trim() || fallbackName,
    repoId,
    repoName: repo?.displayName?.trim() || repoId || 'Unknown Repo'
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
    sessions: [],
    chats: []
  }
}
