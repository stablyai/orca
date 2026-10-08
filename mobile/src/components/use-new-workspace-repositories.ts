import { useEffect, useMemo, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
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

const NO_SERVER_CLIENTS: ReadonlyMap<ExecutionHostId, RpcClient> = new Map()
const NO_SERVER_REPOS: ReadonlyMap<ExecutionHostId, MobileWorkspaceRepo[]> = new Map()

/** One host's repos, or null when it refused or failed to answer. */
async function listHostRepos(client: RpcClient): Promise<MobileWorkspaceRepo[] | null> {
  const listed = nativeChatRepoListRead.interpret(await nativeChatRepoListRead.request(client))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  return listed.accepted ? (listed.value as MobileWorkspaceRepo[]) : null
}

/**
 * A server's repos tagged with that server, as the desktop's composer offers them. Its SSH repos
 * are left out: their connection is the server's, which the phone's SSH gate cannot read.
 */
async function listServerRepos(
  executionHostId: ExecutionHostId,
  client: RpcClient
): Promise<MobileWorkspaceRepo[] | null> {
  const listed = await listHostRepos(client).catch(() => null)
  return (
    listed?.filter((repo) => !repo.connectionId).map((repo) => ({ ...repo, executionHostId })) ??
    null
  )
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
  loading: boolean
} {
  const { client, serverClients = NO_SERVER_CLIENTS, hostId, visible } = args
  const [initialRepos] = useState(() =>
    hostId ? (getCachedRepos(hostId) as MobileWorkspaceRepo[] | null) : null
  )
  const [desktopRepos, setDesktopRepos] = useState<MobileWorkspaceRepo[]>(initialRepos ?? [])
  const [serverRepos, setServerRepos] = useState(NO_SERVER_REPOS)
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
    void listHostRepos(client)
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

  useEffect(() => {
    // A server the phone can no longer reach takes its repos with it.
    setServerRepos((previous) => {
      const kept = [...previous].filter(([host]) => serverClients.has(host))
      return kept.length === previous.size ? previous : new Map(kept)
    })
    if (!visible) {
      return
    }
    let stale = false
    for (const [executionHostId, serverClient] of serverClients) {
      void listServerRepos(executionHostId, serverClient).then((listed) => {
        if (!stale && listed) {
          setServerRepos((previous) => new Map(previous).set(executionHostId, listed))
        }
      })
    }
    return () => {
      stale = true
    }
  }, [visible, serverClients])

  return { repos, selectedRepo, setSelectedRepo, loading: loading && repos.length === 0 }
}
