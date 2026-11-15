import { useEffect } from 'react'
import { getRepoExecutionHostId } from '../../../../src/shared/execution-host'
import { useHostQuery } from '../../query/host-query'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { buildRepoHostIdByRepoId } from '../../worktree/row-presentation/worktree-host-context-labels'
import { buildSshHostHealthById } from '../../worktree/execution-hosts/worktree-host-health'
import type { SectionRepo } from '../../worktree/workspace-list/workspace-list-types'
import {
  catalogNeedsHostLabels,
  HOST_LIST_TARGET,
  hostRepoCatalogQuery,
  hostRepoLabelsQuery,
  NO_HOST_LIST_INPUT
} from './host-list-queries'
import type { HostRepoCatalogRow } from '../host-screen-reply-schema'
import type { HostScreenState } from '../use-host-screen-state'

function desktopSectionRepo(repo: HostRepoCatalogRow): SectionRepo {
  return {
    id: repo.id,
    displayName: repo.displayName,
    path: repo.path ?? repo.id,
    executionHostId: getRepoExecutionHostId(repo),
    ...(repo.badgeColor ? { badgeColor: repo.badgeColor } : {}),
    ...(repo.repoIcon ? { repoIcon: repo.repoIcon } : {})
  }
}

// The host's repos and their host labels; repo metadata is decorative, so a failed read keeps what is shown.
export function useHostRepoMetadata(args: {
  client: RpcClient | null
  hostId: string | undefined
  state: HostScreenState
  subscribed: boolean
}): void {
  const { client, hostId, state, subscribed } = args
  const {
    setHostLabelById,
    setHostHealthById,
    setDesktopRepos,
    setHostPlatform,
    setRepoHostIdByRepoId
  } = state
  const host = { hostId: hostId ?? '', client }
  const options = { enabled: !!hostId, subscribed, refetchInterval: 60_000 }
  const repos = useHostQuery(
    hostRepoCatalogQuery,
    host,
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    options
  )
  const needsLabels = repos.data !== undefined && catalogNeedsHostLabels(repos.data.catalog)
  const labels = useHostQuery(hostRepoLabelsQuery, host, HOST_LIST_TARGET, NO_HOST_LIST_INPUT, {
    ...options,
    enabled: options.enabled && needsLabels
  })
  // Applied when the catalog changes (structural sharing keeps an unchanged one), and again on a host switch,
  // which clears the shown repos while the cache keeps them.
  useEffect(() => {
    if (repos.data) {
      setDesktopRepos(repos.data.catalog.map(desktopSectionRepo))
      setRepoHostIdByRepoId(buildRepoHostIdByRepoId(repos.data.catalog))
    }
  }, [repos.data, hostId])
  useEffect(() => {
    if (needsLabels && labels.data) {
      setHostHealthById(buildSshHostHealthById(labels.data.sshTargetSummaries))
      setHostLabelById(new Map(labels.data.hostLabels))
      setHostPlatform(labels.data.platform)
    } else if (repos.data && !needsLabels) {
      // Clear labels for departed hosts so stale metadata cannot badge remaining rows.
      setHostHealthById(new Map())
      setHostLabelById(new Map())
    }
  }, [needsLabels, labels.data, repos.data, hostId])
}
