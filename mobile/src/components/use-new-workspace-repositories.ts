import { useEffect, useMemo, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc-client'
import { getCachedRepos, setCachedRepos } from '../cache/repo-cache'
import { listHostRepos } from '../worktree/server-repos'
import { useServerRepos } from '../worktree/use-server-repos'
import { useLastVisitedWorktreeRepoId } from '../worktree/use-last-visited-worktree-repo'
import {
  getMobileNewWorkspaceDialogEligibleRepos,
  refreshMobileNewWorkspaceDialogSelectedRepo,
  resolveMobileNewWorkspaceDialogRepoId
} from '../worktree/new-workspace-dialog-repo-selection'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

const NO_SERVER_CLIENTS: ReadonlyMap<ExecutionHostId, RpcClient> = new Map()

// List desktop repos immediately; add each reachable server’s repos as it responds.
export function useNewWorkspaceRepositories(args: {
  client: RpcClient | null
  serverClients?: ReadonlyMap<ExecutionHostId, RpcClient>
  hostId?: string
  visible: boolean
}): {
  repos: MobileWorkspaceRepo[]
  selectedRepo: MobileWorkspaceRepo | null
  setSelectedRepo: (repo: MobileWorkspaceRepo | null) => void
  loading: boolean
} {
  const { client, serverClients = NO_SERVER_CLIENTS, hostId, visible } = args
  const [initialRepos] = useState(() =>
    hostId ? (getCachedRepos(hostId) as MobileWorkspaceRepo[] | null) : null
  )
  const [desktopRepos, setDesktopRepos] = useState<MobileWorkspaceRepo[]>(initialRepos ?? [])
  const serverRepos = useServerRepos<MobileWorkspaceRepo>(serverClients, visible)
  const [pickedRepo, setSelectedRepo] = useState<MobileWorkspaceRepo | null>(null)
  const [loading, setLoading] = useState(initialRepos == null)
  const lastVisitedRepo = useLastVisitedWorktreeRepoId(hostId, visible)
  const repos = useMemo(
    () =>
      serverRepos.size === 0
        ? desktopRepos
        : [...desktopRepos, ...[...serverRepos.values()].flat()],
    [desktopRepos, serverRepos]
  )
  // Derive the pick so it follows updated listings and disappears when its host stops listing it.
  const selectedRepo = useMemo(
    () => refreshMobileNewWorkspaceDialogSelectedRepo(repos, pickedRepo),
    [pickedRepo, repos]
  )

  useEffect(() => {
    if (!visible || !lastVisitedRepo.loaded || selectedRepo || repos.length === 0) {
      return
    }
    const eligibleRepos = getMobileNewWorkspaceDialogEligibleRepos(repos)
    const preferredRepoId = resolveMobileNewWorkspaceDialogRepoId({
      eligibleRepos,
      activeRepoId: lastVisitedRepo.repoId
    })
    const preferredRepo = repos.find((repo) => repo.id === preferredRepoId) ?? null
    if (preferredRepo) {
      setSelectedRepo(preferredRepo)
    }
  }, [lastVisitedRepo.loaded, lastVisitedRepo.repoId, repos, selectedRepo, visible])

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let stale = false
    setLoading(true)
    void listHostRepos<MobileWorkspaceRepo>(client)
      .then((listed) => {
        if (stale || !listed) {
          return
        }
        setDesktopRepos(listed)
        if (hostId) {
          setCachedRepos(hostId, listed)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [visible, client, hostId])

  return { repos, selectedRepo, setSelectedRepo, loading: loading && repos.length === 0 }
}
