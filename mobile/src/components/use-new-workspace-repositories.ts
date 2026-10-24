import { useEffect, useMemo, useRef, useState } from 'react'
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

function isServerExecutionHostId(host: string | null | undefined): host is ExecutionHostId {
  return Boolean(host && host.startsWith('runtime:'))
}

/**
 * The desktop's repos, then each reachable server's as it answers: a slow server never holds back
 * the desktop's own list.
 */
export function useNewWorkspaceRepositories(args: {
  client: RpcClient | null
  /** The desktop's servers this phone can reach now, whose repos are offered too. */
  serverClients?: ReadonlyMap<ExecutionHostId, RpcClient>
  hostId?: string
  visible: boolean
}): {
  repos: MobileWorkspaceRepo[]
  selectedRepo: MobileWorkspaceRepo | null
  setSelectedRepo: (repo: MobileWorkspaceRepo | null) => void
  upsertRepo: (repo: MobileWorkspaceRepo) => void
  loading: boolean
} {
  const { client, serverClients = NO_SERVER_CLIENTS, hostId, visible } = args
  const [initialRepos] = useState(() =>
    hostId ? (getCachedRepos(hostId) as MobileWorkspaceRepo[] | null) : null
  )
  const [desktopRepos, setDesktopRepos] = useState<MobileWorkspaceRepo[]>(initialRepos ?? [])
  const lastCachedDesktopRepos = useRef(desktopRepos)
  const addedReposRef = useRef<Map<string, MobileWorkspaceRepo>>(new Map())
  const [addedServerRepos, setAddedServerRepos] = useState<
    ReadonlyMap<ExecutionHostId, MobileWorkspaceRepo[]>
  >(() => new Map())
  const serverRepos = useServerRepos<MobileWorkspaceRepo>(serverClients, visible)
  const [pickedRepo, setSelectedRepo] = useState<MobileWorkspaceRepo | null>(null)
  const [loading, setLoading] = useState(initialRepos == null)
  const lastVisitedRepo = useLastVisitedWorktreeRepoId(hostId, visible)

  const repos = useMemo(() => {
    const allServerHosts = new Set([...serverRepos.keys(), ...addedServerRepos.keys()])
    const combinedServerRepos: MobileWorkspaceRepo[] = []
    for (const host of allServerHosts) {
      const base = serverRepos.get(host) ?? []
      const added = addedServerRepos.get(host) ?? []
      const addedIds = new Set(added.map((r) => r.id))
      combinedServerRepos.push(...added, ...base.filter((r) => !addedIds.has(r.id)))
    }
    return combinedServerRepos.length === 0
      ? desktopRepos
      : [...desktopRepos, ...combinedServerRepos]
  }, [desktopRepos, serverRepos, addedServerRepos])

  // Why derived: the pick follows its repo's latest listing, and goes once its host stops listing it.
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
        setDesktopRepos((previous) => {
          const listedIds = new Set(listed.map((r) => r.id))
          const addedPreserved = previous.filter(
            (r) => !listedIds.has(r.id) && addedReposRef.current.has(r.id)
          )
          return [...addedPreserved, ...listed]
        })
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

  useEffect(() => {
    if (lastCachedDesktopRepos.current === desktopRepos) {
      return
    }
    lastCachedDesktopRepos.current = desktopRepos
    if (hostId) {
      setCachedRepos(hostId, desktopRepos)
    }
  }, [desktopRepos, hostId])

  function upsertRepo(repo: MobileWorkspaceRepo): void {
    addedReposRef.current.set(repo.id, repo)
    const host = repo.executionHostId
    if (isServerExecutionHostId(host)) {
      setAddedServerRepos((previous) => {
        const currentList = previous.get(host) ?? []
        const existingIndex = currentList.findIndex((candidate) => candidate.id === repo.id)
        const nextList =
          existingIndex !== -1
            ? currentList.map((candidate, index) => (index === existingIndex ? repo : candidate))
            : [repo, ...currentList]
        return new Map(previous).set(host, nextList)
      })
    } else {
      setDesktopRepos((previous) => {
        const existingIndex = previous.findIndex((candidate) => candidate.id === repo.id)
        return existingIndex !== -1
          ? previous.map((candidate, index) => (index === existingIndex ? repo : candidate))
          : [repo, ...previous]
      })
    }
    setSelectedRepo(repo)
  }

  return {
    repos,
    selectedRepo,
    setSelectedRepo,
    upsertRepo,
    loading: loading && repos.length === 0
  }
}
