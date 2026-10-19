import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { HostContextLabelSources } from '../../../src/shared/worktree/host-context-labels'
import { useHostDescriptor } from '../transport/host-descriptor-store'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { withServerHosts } from '../worktree/server-workspaces'
import { useReachableServerClients } from '../worktree/use-reachable-server-clients'
import { useServerRepos } from '../worktree/use-server-repos'
import type { RepoSummary } from './mobile-tasks-provider-detail-types'
import { routeTaskRepoCalls } from './task-repo-host-routing'
import type { HostRepoListResource } from './use-host-repo-list'

const NO_LABELS: ReadonlyMap<ExecutionHostId, string> = new Map()

/**
 * The Tasks screen's repos across the desktop and its servers, as the desktop's task page lists
 * them: the desktop's list settles on its own, and each server's joins as it answers.
 */
export function useTaskHostRepos(args: {
  hostId: string | undefined
  desktopClient: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
  desktopRepoList: HostRepoListResource<RepoSummary>
}) {
  const { hostId, desktopClient, connState, hostCapabilities, desktopRepoList } = args
  const { servers, serverClients } = useReachableServerClients(desktopClient, hostCapabilities)
  const [serverListGeneration, setServerListGeneration] = useState(0)
  const reposByHost = useServerRepos<RepoSummary>(
    serverClients,
    connState === 'connected',
    serverListGeneration
  )
  const serverRepoList = useMemo(() => [...reposByHost.values()].flat(), [reposByHost])
  const desktopPlatform = useHostDescriptor(hostId)?.platform ?? null
  // Names hosts only once a server's repos mix in, as the desktop's mixed lists do.
  const repoHostLabels = useMemo<HostContextLabelSources | null>(
    () =>
      serverRepoList.length === 0
        ? null
        : {
            hostLabelById: withServerHosts(NO_LABELS, servers ?? [], (host) => host.label),
            hostPlatform: desktopPlatform
          },
    [desktopPlatform, serverRepoList, servers]
  )
  const desktopRepos = desktopRepoList.state.repos
  const repos = useMemo(
    () => (serverRepoList.length === 0 ? desktopRepos : [...desktopRepos, ...serverRepoList]),
    [desktopRepos, serverRepoList]
  )

  // Why a ref: a call can follow the list's arrival before React commits it.
  const serverReposRef = useRef(serverRepoList)
  useLayoutEffect(() => {
    serverReposRef.current = serverRepoList
  }, [serverRepoList])
  const { current: currentDesktopRepos, ensureLoaded, reload } = desktopRepoList
  const client = useMemo(
    () =>
      desktopClient &&
      routeTaskRepoCalls(desktopClient, () => [
        ...currentDesktopRepos(),
        ...serverReposRef.current
      ]),
    [currentDesktopRepos, desktopClient]
  )

  const repoListEnsureLoaded = useCallback(
    async (): Promise<RepoSummary[]> => [...(await ensureLoaded()), ...serverReposRef.current],
    [ensureLoaded]
  )
  const repoListReload = useCallback(async (): Promise<RepoSummary[]> => {
    setServerListGeneration((generation) => generation + 1)
    return [...(await reload()), ...serverReposRef.current]
  }, [reload])

  return {
    client,
    repos,
    serverRepoList,
    repoListEnsureLoaded,
    repoListReload,
    repoHostLabels
  }
}
