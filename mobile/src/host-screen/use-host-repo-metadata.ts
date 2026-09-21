import { useCallback } from 'react'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { setCachedRepos } from '../cache/repo-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import type { RepoSummary } from '../worktree/host-worktree-rpc-types'
import { repoColor } from '../worktree/repo-color'
import {
  buildHostLabelById,
  buildRepoHostIdByRepoId
} from '../worktree/worktree-host-context-labels'
import type { HostScreenState } from './use-host-screen-state'

const REPO_METADATA_REFRESH_MS = 60_000

type SshTargetSummaryRow = { id: string; label: string }

async function requestResult(client: RpcClient, method: string): Promise<unknown> {
  try {
    const response = await client.sendRequest(method)
    return response.ok ? (response as RpcSuccess).result : null
  } catch {
    // Best-effort: hosts that predate a method still list repos; labels degrade to host ids.
    return null
  }
}

function readSshTargets(result: unknown): SshTargetSummaryRow[] {
  const targets = (result as { targets?: unknown } | null)?.targets
  if (!Array.isArray(targets)) {
    return []
  }
  return targets.filter(
    (target): target is SshTargetSummaryRow =>
      typeof target === 'object' &&
      target !== null &&
      typeof (target as SshTargetSummaryRow).id === 'string' &&
      typeof (target as SshTargetSummaryRow).label === 'string'
  )
}

function readHostPlatform(result: unknown): NodeJS.Platform | null {
  const platform = (result as { platform?: unknown } | null)?.platform
  return typeof platform === 'string' && platform ? (platform as NodeJS.Platform) : null
}

function readHostSettingOverrides(result: unknown): unknown {
  return (result as { settings?: { hostSettingOverrides?: unknown } } | null)?.settings
    ?.hostSettingOverrides
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
    setHostPlatform,
    setRepoColorsByName,
    setRepoHostIdByRepoId,
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
          setRepoHostIdByRepoId(buildRepoHostIdByRepoId(repoResult.repos))
          // Why: rows only name their host when the list spans hosts, so a single-host
          // catalog never pays for the label lookups. Counted over repos, not the id-keyed
          // map: one repo id registered on two hosts is two hosts.
          const hostIds = new Set(repoResult.repos.map((repo) => getRepoExecutionHostId(repo)))
          if (hostIds.size > 1) {
            const [sshTargets, hostSettings, hostPlatform] = await Promise.all([
              requestResult(requestClient, 'ssh.listTargetSummaries'),
              requestResult(requestClient, 'settings.get'),
              requestResult(requestClient, 'host.platform')
            ])
            if (clientRef.current !== requestClient || hostId !== requestHostId) {
              return
            }
            setHostLabelById(
              buildHostLabelById({
                sshTargets: readSshTargets(sshTargets),
                hostSettingOverrides: readHostSettingOverrides(hostSettings)
              })
            )
            setHostPlatform(readHostPlatform(hostPlatform))
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
