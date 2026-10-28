import { useCallback } from 'react'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../src/shared/execution-host'
import { setCachedRepos } from '../cache/repo-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { buildRepoHostIdByRepoId } from '../worktree/worktree-host-context-labels'
import { buildSshHostHealthById } from '../worktree/worktree-host-health'
import type { SectionRepo } from '../worktree/workspace-list-types'
import type { HostRepoCatalogRow } from './host-screen-reply-schema'
import { hostPlatformRead, hostRepoCatalogRead } from './host-screen-operations'
import {
  acceptedMetadata,
  readHostSshTargetLabels,
  settledMetadataReply
} from './host-ssh-target-labels-read'
import type { HostScreenState } from './use-host-screen-state'

const REPO_METADATA_REFRESH_MS = 60_000

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

export function useHostRepoMetadata(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string | undefined
  state: HostScreenState
}) {
  const { client, connState, hostId, state } = args
  const {
    clientRef,
    fetchRepoMetadataInFlightRef,
    fetchRepoMetadataPendingRef,
    repoMetadataFetchedAtRef,
    setHostLabelById,
    setHostHealthById,
    setDesktopRepos,
    setHostPlatform,
    setRepoHostIdByRepoId
  } = state

  const fetchRepoMetadata = useCallback(
    async (options: { force?: boolean; queueIfInFlight?: boolean } = {}) => {
      if (!client || connState !== 'connected' || !hostId) {
        return
      }
      if (fetchRepoMetadataInFlightRef.current.has(client)) {
        if (options.queueIfInFlight) {
          fetchRepoMetadataPendingRef.current.add(client)
        }
        return
      }
      const now = Date.now()
      if (!options.force && now - repoMetadataFetchedAtRef.current < REPO_METADATA_REFRESH_MS) {
        return
      }
      fetchRepoMetadataInFlightRef.current.add(client)
      const requestClient = client,
        requestHostId = hostId
      try {
        do {
          fetchRepoMetadataPendingRef.current.delete(requestClient)
          const repoReply = await settledMetadataReply(() =>
            hostRepoCatalogRead.request(requestClient)
          )
          if (clientRef.current !== requestClient || hostId !== requestHostId) {
            return
          }
          const repos = repoReply && hostRepoCatalogRead.interpret(repoReply)
          if (!repos || !repos.accepted) {
            return
          }
          const catalog = repos.value
          repoMetadataFetchedAtRef.current = Date.now()
          setCachedRepos(requestHostId, catalog)
          setDesktopRepos(catalog.map(desktopSectionRepo))
          setRepoHostIdByRepoId(buildRepoHostIdByRepoId(catalog))
          // Fetch labels only for mixed-host or potentially unhealthy SSH rows. Count repos, not the id-keyed map: the same repo id may exist on two hosts.
          const hostIds = new Set(catalog.map((repo) => getRepoExecutionHostId(repo)))
          const hasSshHost = [...hostIds].some((id) => parseExecutionHostId(id)?.kind === 'ssh')
          if (hostIds.size > 1 || hasSshHost) {
            const [{ sshTargetSummaries, hostLabelById }, hostPlatform] = await Promise.all([
              readHostSshTargetLabels(requestClient),
              settledMetadataReply(() => hostPlatformRead.request(requestClient))
            ])
            if (clientRef.current !== requestClient || hostId !== requestHostId) {
              return
            }
            setHostHealthById(buildSshHostHealthById(sshTargetSummaries))
            setHostLabelById(hostLabelById)
            setHostPlatform(acceptedMetadata(hostPlatform, hostPlatformRead.interpret) ?? null)
          } else {
            // Clear labels for departed hosts so stale metadata cannot badge remaining rows.
            setHostHealthById(new Map())
            setHostLabelById(new Map())
          }
        } while (fetchRepoMetadataPendingRef.current.has(requestClient))
      } catch {
        // Repo metadata is decorative; the next refresh can retry.
      } finally {
        fetchRepoMetadataInFlightRef.current.delete(requestClient)
      }
    },
    [client, connState, hostId]
  )

  return fetchRepoMetadata
}

export type FetchHostRepoMetadata = ReturnType<typeof useHostRepoMetadata>
