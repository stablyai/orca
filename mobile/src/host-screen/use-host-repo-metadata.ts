import { useCallback } from 'react'
import { setCachedRepos } from '../cache/repo-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import type { RepoSummary } from '../worktree/host-worktree-rpc-types'
import { repoColor } from '../worktree/repo-color'
import type { HostScreenState } from './use-host-screen-state'

const REPO_METADATA_REFRESH_MS = 60_000

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
    setRepoColorsByName,
    setRepoIconsByName,
    setRepoIdsByName
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
          const repoResponse = await requestClient.sendRequest('repo.list')
          if (clientRef.current !== requestClient || hostId !== requestHostId || !repoResponse.ok) {
            return
          }
          const repoResult = (repoResponse as RpcSuccess).result as { repos: RepoSummary[] }
          repoMetadataFetchedAtRef.current = Date.now()
          setCachedRepos(requestHostId, repoResult.repos)
          setRepoColorsByName(
            new Map(
              repoResult.repos.map((repo) => [
                repo.displayName,
                repo.badgeColor || repoColor(repo.displayName)
              ])
            )
          )
          setRepoIconsByName(
            new Map(
              repoResult.repos.flatMap((repo) =>
                repo.repoIcon ? [[repo.displayName, repo.repoIcon] as const] : []
              )
            )
          )
          setRepoIdsByName(new Map(repoResult.repos.map((repo) => [repo.displayName, repo.id])))
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
