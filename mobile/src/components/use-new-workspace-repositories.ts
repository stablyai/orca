import { useEffect, useMemo, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc-client'
import { getCachedRepos, setCachedRepos } from '../cache/repo-cache'
import { listHostRepos } from '../worktree/server-repos'
import { useServerRepos } from '../worktree/use-server-repos'
import { useLastVisitedWorktreeRepoId } from '../worktree/use-last-visited-worktree-repo'
import { refreshMobileNewWorkspaceDialogSelectedRepo } from '../worktree/new-workspace-dialog-repo-selection'
import {
  getNewWorkspaceDialogEligibleRepos,
  resolveNewWorkspaceDialogRepoId
} from '../../../src/shared/new-workspace-dialog-repo'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

const NO_SERVER_CLIENTS: ReadonlyMap<ExecutionHostId, RpcClient> = new Map()

// List desktop repos immediately; add each reachable server’s repos as it responds.
export function useNewWorkspaceRepositories(args: {
  client: RpcClient | null
  serverClients?: ReadonlyMap<ExecutionHostId, RpcClient>
  hostId?: string
  visible: boolean
  initialRepoId?: string | null
}): {
  repos: MobileWorkspaceRepo[]
  allRepos: MobileWorkspaceRepo[]
  selectedRepo: MobileWorkspaceRepo | null
  setSelectedRepo: (repo: MobileWorkspaceRepo | null) => void
  loading: boolean
} {
  const { client, serverClients = NO_SERVER_CLIENTS, hostId, visible, initialRepoId } = args
  const [initialRepos] = useState(() =>
    hostId ? (getCachedRepos(hostId) as MobileWorkspaceRepo[] | null) : null
  )
  const [desktopRepos, setDesktopRepos] = useState<MobileWorkspaceRepo[]>(initialRepos ?? [])
  const serverRepos = useServerRepos<MobileWorkspaceRepo>(serverClients, visible)
  const [pickedRepo, setSelectedRepo] = useState<MobileWorkspaceRepo | null>(null)
  const [loading, setLoading] = useState(initialRepos == null)
  // The cached list predates a just-added project, so a preferred pick waits for a fresh one.
  const [listedFresh, setListedFresh] = useState(false)
  const lastVisitedRepo = useLastVisitedWorktreeRepoId(hostId, visible)
  // Why: trust checks count same-id rows on every host, as desktop does; only the picker filters.
  const allRepos = useMemo(
    () =>
      serverRepos.size === 0
        ? desktopRepos
        : [...desktopRepos, ...[...serverRepos.values()].flat()],
    [desktopRepos, serverRepos]
  )
  const repos = useMemo(() => getNewWorkspaceDialogEligibleRepos(allRepos), [allRepos])
  // Derive the pick so it follows updated listings and disappears when its host stops listing it.
  const selectedRepo = useMemo(
    () => refreshMobileNewWorkspaceDialogSelectedRepo(repos, pickedRepo),
    [pickedRepo, repos]
  )

  useEffect(() => {
    if (!visible || !lastVisitedRepo.loaded || selectedRepo) {
      return
    }
    if (initialRepoId) {
      // Repo ids are unique per host; the just-added project lives on the focused host.
      const initialRepo = desktopRepos.find((repo) => repo.id === initialRepoId)
      if (initialRepo) {
        setSelectedRepo(initialRepo)
        return
      }
      if (!listedFresh) {
        return
      }
    }
    if (repos.length === 0) {
      return
    }
    const preferredRepoId = resolveNewWorkspaceDialogRepoId({
      eligibleRepos: repos,
      activeRepoId: lastVisitedRepo.repoId
    })
    const preferredRepo = repos.find((repo) => repo.id === preferredRepoId) ?? null
    if (preferredRepo) {
      setSelectedRepo(preferredRepo)
    }
  }, [
    lastVisitedRepo.loaded,
    lastVisitedRepo.repoId,
    desktopRepos,
    initialRepoId,
    listedFresh,
    repos,
    selectedRepo,
    visible
  ])

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
        // A failed listing keeps a just-added project's pick pending instead of preselecting another repo.
        setListedFresh(true)
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

  return { repos, allRepos, selectedRepo, setSelectedRepo, loading: loading && repos.length === 0 }
}
