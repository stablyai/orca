import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { cachedHostRepos } from '../host-screen/host-list-queries'
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
  /** Picked once it is listed, in place of the last visited repo. */
  initialRepo?: { id: string; executionHostId: ExecutionHostId }
}): {
  repos: MobileWorkspaceRepo[]
  allRepos: MobileWorkspaceRepo[]
  selectedRepo: MobileWorkspaceRepo | null
  setSelectedRepo: (repo: MobileWorkspaceRepo | null) => void
  loading: boolean
  /** Set when the project list failed to load and nothing is cached to show. */
  loadError: string | null
  retryLoad: () => void
} {
  const { client, serverClients = NO_SERVER_CLIENTS, hostId, visible, initialRepo } = args
  const queryClient = useQueryClient()
  // The host list's repos, so the form opens with them while repo.list answers.
  const [initialRepos] = useState(() => cachedHostRepos<MobileWorkspaceRepo>(queryClient, hostId))
  const [desktopRepos, setDesktopRepos] = useState<MobileWorkspaceRepo[]>(initialRepos ?? [])
  const serverRepos = useServerRepos<MobileWorkspaceRepo>(serverClients, visible)
  const [pickedRepo, setSelectedRepo] = useState<MobileWorkspaceRepo | null>(null)
  const [loading, setLoading] = useState(initialRepos == null)
  // Null until a read fails; an empty string is a refusal with no reason to show.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const lastVisitedRepo = useLastVisitedWorktreeRepoId(hostId, visible)
  // Why: trust checks count same-id rows on every host, as desktop does; only the picker filters.
  const allRepos = useMemo(
    () =>
      serverRepos.size === 0
        ? desktopRepos
        : [...desktopRepos, ...[...serverRepos.values()].flat()],
    [desktopRepos, serverRepos]
  )
  const initialRepoId = initialRepo?.id
  const initialRepoHost = initialRepo?.executionHostId
  // Opened for one host's folder: every picker offers only that host, whose store holds the folder.
  const repos = useMemo(() => {
    const eligible = getNewWorkspaceDialogEligibleRepos(allRepos)
    return initialRepoHost
      ? eligible.filter((repo) => getRepoExecutionHostId(repo) === initialRepoHost)
      : eligible
  }, [allRepos, initialRepoHost])
  // Derive the pick so it follows updated listings and disappears when its host stops listing it.
  const selectedRepo = useMemo(
    () => refreshMobileNewWorkspaceDialogSelectedRepo(repos, pickedRepo),
    [pickedRepo, repos]
  )

  useEffect(() => {
    if (!visible || selectedRepo || !initialRepoId) {
      return
    }
    // Waits for its host's listing: a same-id repo on another host is a different repo.
    const initial = repos.find(
      (repo) => repo.id === initialRepoId && getRepoExecutionHostId(repo) === initialRepoHost
    )
    if (initial) {
      setSelectedRepo(initial)
    }
  }, [initialRepoHost, initialRepoId, repos, selectedRepo, visible])

  useEffect(() => {
    if (
      !visible ||
      initialRepoId ||
      !lastVisitedRepo.loaded ||
      selectedRepo ||
      repos.length === 0
    ) {
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
  }, [initialRepoId, lastVisitedRepo.loaded, lastVisitedRepo.repoId, repos, selectedRepo, visible])

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let stale = false
    setLoading(true)
    setLoadError(null)
    void listHostRepos<MobileWorkspaceRepo>(client)
      .then((listed) => {
        if (stale) {
          return
        }
        if (!listed) {
          setLoadError('')
          return
        }
        setDesktopRepos(listed)
      })
      .catch((err: unknown) => {
        if (!stale) {
          setLoadError(err instanceof Error ? err.message : '')
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [visible, client, hostId, loadAttempt])

  return {
    repos,
    allRepos,
    selectedRepo,
    setSelectedRepo,
    loading: loading && repos.length === 0,
    // Cached rows stay usable, so a failed refresh only matters when there is nothing to pick.
    loadError: repos.length === 0 ? loadError : null,
    retryLoad: () => setLoadAttempt((attempt) => attempt + 1)
  }
}
