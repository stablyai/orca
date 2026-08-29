import { ipcMain } from 'electron'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getSshGitProvider } from '../../../providers/ssh-git-dispatch'
import { pruneLineageForMissingRepoWorktrees } from '../../../worktree-lineage-pruning'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import { getRetiredNameRegistryForRepo } from '../../../worktree-name-retirement'
import {
  buildDetectedGitWorktrees,
  createSshWorktreeMetaIndex,
  listDisconnectedSshWorktrees,
  stampAndMergeVisibleDetectedWorktree
} from './ssh-worktree-fallback'
import { listVisibleFolderWorkspaces } from './folder-workspace-catalog'
import {
  listDetectedGitWorktrees,
  rememberLocalWorktreeRoots
} from './detected-worktree-scan-cache'
import {
  loggedUnavailableSshGitProviders,
  loggedWorktreeListFailures,
  warnOnce
} from './worktree-listing-diagnostics'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

const WORKTREE_LIST_ALL_CONCURRENCY = 8

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

export function registerWorktreeCatalogHandlers(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle('worktrees:listAll', async () => {
    const repos = store.getRepos()
    const legacyMetadata =
      typeof store.getAllWorktreeMetaForHost === 'function' ? undefined : store.getAllWorktreeMeta()
    const metadataByHost = new Map<ExecutionHostId, Record<string, WorktreeMeta>>()
    const metadataForRepo = (repo: (typeof repos)[number]): Record<string, WorktreeMeta> => {
      const hostId = getRepoExecutionHostId(repo)
      const cached = metadataByHost.get(hostId)
      if (cached) {
        return cached
      }
      const metadata =
        typeof store.getAllWorktreeMetaForHost === 'function'
          ? store.getAllWorktreeMetaForHost(hostId)
          : readAllWorktreeMetaForHost({ getAllWorktreeMeta: () => legacyMetadata ?? {} }, hostId)
      metadataByHost.set(hostId, metadata)
      return metadata
    }
    const sshMetaIndexByHost = new Map<
      ExecutionHostId,
      ReturnType<typeof createSshWorktreeMetaIndex>
    >()
    const sshMetaIndexForRepo = (repo: (typeof repos)[number]) => {
      const hostId = getRepoExecutionHostId(repo)
      const cached = sshMetaIndexByHost.get(hostId)
      if (cached) {
        return cached
      }
      const index = createSshWorktreeMetaIndex(Object.entries(metadataForRepo(repo)))
      sshMetaIndexByHost.set(hostId, index)
      return index
    }

    // Why: each local repo listing can spawn `git worktree list`; cap fan-out so large fleets don't start unbounded subprocesses.
    const results = await mapWithConcurrency(repos, WORKTREE_LIST_ALL_CONCURRENCY, async (repo) => {
      try {
        let gitWorktrees
        let freshScan = true
        if (isFolderRepo(repo)) {
          return listVisibleFolderWorkspaces(store, repo)
        } else if (repo.connectionId) {
          const provider = getSshGitProvider(repo.connectionId)
          if (!provider) {
            warnOnce(
              loggedUnavailableSshGitProviders,
              `${repo.connectionId}:${repo.id}`,
              `[worktrees] SSH git provider unavailable; skipping worktree list for repo "${repo.displayName}" (${repo.id}) at ${repo.path} on connection ${repo.connectionId}`
            )
            return listDisconnectedSshWorktrees(store, repo, sshMetaIndexForRepo(repo))
          }
          loggedUnavailableSshGitProviders.delete(`${repo.connectionId}:${repo.id}`)
          try {
            gitWorktrees = await provider.listWorktrees(repo.path)
          } catch (err) {
            warnOnce(
              loggedWorktreeListFailures,
              `${repo.id}:${repo.path}`,
              `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
              err
            )
            return listDisconnectedSshWorktrees(store, repo, sshMetaIndexForRepo(repo))
          }
        } else {
          const scan = await listDetectedGitWorktrees(store, repo)
          gitWorktrees = scan.gitWorktrees
          freshScan = scan.fresh
        }
        if (freshScan) {
          rememberLocalWorktreeRoots(store, repo, gitWorktrees)
          pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
        }
        loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
        const metadata = metadataForRepo(repo)
        return buildDetectedGitWorktrees(store, repo, gitWorktrees, metadata)
          .filter((worktree) => worktree.visible)
          .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repo, worktree, metadata))
      } catch (err) {
        warnOnce(
          loggedWorktreeListFailures,
          `${repo.id}:${repo.path}`,
          `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
          err
        )
        // Why: do NOT seed empty success — it flags the repo registered, blocking access to legit linked worktrees until the cache is invalidated.
        return []
      }
    })

    return results.flat()
  })

  ipcMain.handle('worktrees:listRetiredNames', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      return EMPTY_RETIRED_NAME_REGISTRY
    }
    return getRetiredNameRegistryForRepo(store, repo, store.getRepos(), store.getSettings())
  })

  ipcMain.handle('worktrees:list', async (_event, args: { repoId: string } | undefined) => {
    // Renderer startup can race repo selection; malformed requests must fail closed, not crash the handler.
    const repoId = typeof args?.repoId === 'string' ? args.repoId : ''
    if (!repoId) {
      return []
    }
    const repo = store.getRepo(repoId)
    if (!repo) {
      return []
    }
    const allMeta = repo.connectionId
      ? readAllWorktreeMetaForHost(store, getRepoExecutionHostId(repo))
      : undefined
    const sshWorktreeMetaIndex = repo.connectionId
      ? createSshWorktreeMetaIndex(Object.entries(allMeta ?? {}))
      : new Map()

    try {
      let gitWorktrees
      let freshScan = true
      if (isFolderRepo(repo)) {
        return listVisibleFolderWorkspaces(store, repo)
      } else if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          warnOnce(
            loggedUnavailableSshGitProviders,
            `${repo.connectionId}:${repo.id}`,
            `[worktrees] SSH git provider unavailable; skipping worktree list for repo "${repo.displayName}" (${repo.id}) at ${repo.path} on connection ${repo.connectionId}`
          )
          return listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
        }
        loggedUnavailableSshGitProviders.delete(`${repo.connectionId}:${repo.id}`)
        try {
          gitWorktrees = await provider.listWorktrees(repo.path)
        } catch (err) {
          warnOnce(
            loggedWorktreeListFailures,
            `${repo.id}:${repo.path}`,
            `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
            err
          )
          return listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
        }
      } else {
        const scan = await listDetectedGitWorktrees(store, repo)
        gitWorktrees = scan.gitWorktrees
        freshScan = scan.fresh
      }
      if (freshScan) {
        rememberLocalWorktreeRoots(store, repo, gitWorktrees)
        pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
      }
      loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
      const metadata = allMeta ?? readAllWorktreeMetaForHost(store, getRepoExecutionHostId(repo))
      return buildDetectedGitWorktrees(store, repo, gitWorktrees, metadata)
        .filter((worktree) => worktree.visible)
        .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repo, worktree, metadata))
    } catch (err) {
      warnOnce(
        loggedWorktreeListFailures,
        `${repo.id}:${repo.path}`,
        `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
        err
      )
      // Why: see worktrees:listAll catch — seeding an empty-success result would poison the auth cache and block linked worktrees.
      return []
    }
  })
}
