import { ipcMain } from 'electron'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getSshGitProvider } from '../../../providers/ssh-git-dispatch'
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
  applyFreshDetectedWorktreeScanSideEffects,
  listDetectedGitWorktrees,
  type DetectedWorktreeMetadataPrune,
  type DetectedWorktreeSideEffectToken
} from './detected-worktree-scan-cache'
import {
  loggedUnavailableSshGitProviders,
  loggedWorktreeListFailures,
  warnOnce
} from './worktree-listing-diagnostics'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  readAllWorktreeMetaForHost,
  readAllWorktreeMetaForRepo
} from '../../../persistence/host-qualified-worktree-meta'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getLocalWorktreeScanGeneration } from '../../../local-worktree-scan-generation'
import { getRegisteredWorktreeRootsRevision } from '../../registered-worktree-roots-cache'

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
      const connectionId = getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
      try {
        let gitWorktrees
        let freshScan = true
        let sideEffectToken: DetectedWorktreeSideEffectToken | undefined
        let metadataPrune: DetectedWorktreeMetadataPrune | undefined
        let hygieneDue: boolean | undefined
        if (isFolderRepo(repo)) {
          return listVisibleFolderWorkspaces(store, repo)
        } else if (connectionId) {
          const provider = getSshGitProvider(connectionId)
          if (!provider) {
            warnOnce(
              loggedUnavailableSshGitProviders,
              `${connectionId}:${repo.id}`,
              `[worktrees] SSH git provider unavailable; skipping worktree list for repo "${repo.displayName}" (${repo.id}) at ${repo.path} on connection ${connectionId}`
            )
            return listDisconnectedSshWorktrees(store, repo, sshMetaIndexForRepo(repo))
          }
          loggedUnavailableSshGitProviders.delete(`${connectionId}:${repo.id}`)
          try {
            sideEffectToken = {
              generation: getLocalWorktreeScanGeneration(repo.id),
              authorizedRootsRevision: getRegisteredWorktreeRootsRevision(repo.id)
            }
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
          sideEffectToken = scan.sideEffectToken
          metadataPrune = scan.metadataPrune
          hygieneDue = scan.hygieneDue
        }
        if (freshScan) {
          await applyFreshDetectedWorktreeScanSideEffects(
            store,
            repo,
            gitWorktrees,
            metadataPrune,
            {
              sideEffectToken,
              ...(hygieneDue === undefined ? {} : { hygieneDue })
            }
          )
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
    const connectionId = getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
    const allMeta = connectionId ? readAllWorktreeMetaForRepo(store, repo) : undefined
    const sshWorktreeMetaIndex = connectionId
      ? createSshWorktreeMetaIndex(Object.entries(allMeta ?? {}))
      : new Map()

    try {
      let gitWorktrees
      let freshScan = true
      let sideEffectToken: DetectedWorktreeSideEffectToken | undefined
      let metadataPrune: DetectedWorktreeMetadataPrune | undefined
      let hygieneDue: boolean | undefined
      if (isFolderRepo(repo)) {
        return listVisibleFolderWorkspaces(store, repo)
      } else if (connectionId) {
        const provider = getSshGitProvider(connectionId)
        if (!provider) {
          warnOnce(
            loggedUnavailableSshGitProviders,
            `${connectionId}:${repo.id}`,
            `[worktrees] SSH git provider unavailable; skipping worktree list for repo "${repo.displayName}" (${repo.id}) at ${repo.path} on connection ${connectionId}`
          )
          return listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
        }
        loggedUnavailableSshGitProviders.delete(`${connectionId}:${repo.id}`)
        try {
          sideEffectToken = {
            generation: getLocalWorktreeScanGeneration(repo.id),
            authorizedRootsRevision: getRegisteredWorktreeRootsRevision(repo.id)
          }
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
        sideEffectToken = scan.sideEffectToken
        metadataPrune = scan.metadataPrune
        hygieneDue = scan.hygieneDue
      }
      if (freshScan) {
        await applyFreshDetectedWorktreeScanSideEffects(store, repo, gitWorktrees, metadataPrune, {
          sideEffectToken,
          ...(hygieneDue === undefined ? {} : { hygieneDue })
        })
      }
      loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
      const metadata = allMeta ?? readAllWorktreeMetaForRepo(store, repo)
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
