import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { nativeChatRepoListRead } from '../session/mobile-session-read-operations'
import { getCachedRepos, setCachedRepos } from '../cache/repo-cache'
import { useLastVisitedWorktreeRepoId } from '../worktree/use-last-visited-worktree-repo'
import {
  getMobileNewWorkspaceDialogEligibleRepos,
  refreshMobileNewWorkspaceDialogSelectedRepo,
  resolveMobileNewWorkspaceDialogRepoId
} from '../worktree/new-workspace-dialog-repo-selection'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

export function useNewWorkspaceRepositories(args: {
  client: RpcClient | null
  hostId?: string
  visible: boolean
}): {
  repos: MobileWorkspaceRepo[]
  selectedRepo: MobileWorkspaceRepo | null
  setSelectedRepo: (repo: MobileWorkspaceRepo | null) => void
  loading: boolean
} {
  const { client, hostId, visible } = args
  const [initialRepos] = useState(() =>
    hostId ? (getCachedRepos(hostId) as MobileWorkspaceRepo[] | null) : null
  )
  const [repos, setRepos] = useState<MobileWorkspaceRepo[]>(initialRepos ?? [])
  const [selectedRepo, setSelectedRepo] = useState<MobileWorkspaceRepo | null>(null)
  const [loading, setLoading] = useState(initialRepos == null)
  const lastVisitedRepo = useLastVisitedWorktreeRepoId(hostId, visible)

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
    void nativeChatRepoListRead
      .request(client)
      .then((response) => {
        if (stale) {
          return
        }
        const listed = nativeChatRepoListRead.interpret(response)
        if (!listed.accepted) {
          return
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
        const listedRepos = listed.value as MobileWorkspaceRepo[]
        setRepos(listedRepos)
        if (hostId) {
          setCachedRepos(hostId, listedRepos)
        }
        setSelectedRepo((current) =>
          refreshMobileNewWorkspaceDialogSelectedRepo(listedRepos, current)
        )
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
