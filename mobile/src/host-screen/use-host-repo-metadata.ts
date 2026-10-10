import { optionalSettingsRead } from '../transport/settings-read-operations'
import { useCallback } from 'react'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../src/shared/execution-host'
import { setCachedRepos } from '../cache/repo-cache'
import type { RpcAcceptedResult } from '../transport/rpc-accepted-result'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { repoColor } from '../worktree/repo-color'
import {
  buildHostLabelById,
  buildRepoHostIdByRepoId
} from '../worktree/worktree-host-context-labels'
import { buildSshHostHealthById } from '../worktree/worktree-host-health'
import {
  hostPlatformRead,
  hostRepoCatalogRead,
  hostSshTargetSummariesRead
} from './host-screen-operations'
import type { HostScreenState } from './use-host-screen-state'

const REPO_METADATA_REFRESH_MS = 60_000

async function settledMetadataReply(send: () => Promise<RpcResponse>): Promise<RpcResponse | null> {
  try {
    return await send()
  } catch {
    // Best-effort: hosts that predate a method still list repos; labels degrade to host ids.
    return null
  }
}

/** An accepted metadata payload, or null for a refusal or a send that never landed. */
function acceptedMetadata<Value>(
  reply: RpcResponse | null,
  interpret: (reply: RpcResponse) => RpcAcceptedResult<Value>
): Value | null {
  if (!reply) {
    return null
  }
  const verdict = interpret(reply)
  return verdict.accepted ? verdict.value : null
}

function readHostSettingOverrides(result: unknown): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  return (result as { hostSettingOverrides?: unknown } | null)?.hostSettingOverrides
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
          setRepoColorsByName(
            new Map(
              catalog.map((repo) => [
                repo.displayName,
                repo.badgeColor || repoColor(repo.displayName)
              ])
            )
          )
          setRepoIconsByName(
            new Map(
              catalog.flatMap((repo) =>
                repo.repoIcon ? [[repo.displayName, repo.repoIcon] as const] : []
              )
            )
          )
          setRepoIdsByName(new Map(catalog.map((repo) => [repo.displayName, repo.id])))
          setRepoHostIdByRepoId(buildRepoHostIdByRepoId(catalog))
          // Why: rows name their host when the list spans hosts or an SSH host may be unhealthy,
          // so a local-only catalog never pays for the label lookups. Counted over repos, not the
          // id-keyed map: one repo id registered on two hosts is two hosts.
          const hostIds = new Set(catalog.map((repo) => getRepoExecutionHostId(repo)))
          const hasSshHost = [...hostIds].some((id) => parseExecutionHostId(id)?.kind === 'ssh')
          if (hostIds.size > 1 || hasSshHost) {
            const [sshTargets, hostSettings, hostPlatform] = await Promise.all([
              settledMetadataReply(() => hostSshTargetSummariesRead.request(requestClient)),
              optionalSettingsRead.request(requestClient).catch(() => null),
              settledMetadataReply(() => hostPlatformRead.request(requestClient))
            ])
            if (clientRef.current !== requestClient || hostId !== requestHostId) {
              return
            }
            const hostSettingsResult = hostSettings
              ? optionalSettingsRead.interpret(hostSettings)
              : null
            const sshTargetSummaries =
              acceptedMetadata(sshTargets, hostSshTargetSummariesRead.interpret) ?? []
            setHostHealthById(buildSshHostHealthById(sshTargetSummaries))
            setHostLabelById(
              buildHostLabelById({
                sshTargets: sshTargetSummaries,
                hostSettingOverrides: readHostSettingOverrides(
                  hostSettingsResult?.accepted ? hostSettingsResult.value : undefined
                )
              })
            )
            setHostPlatform(acceptedMetadata(hostPlatform, hostPlatformRead.interpret) ?? null)
          } else {
            // Why: a host that left the catalog must not keep badging rows that still name it.
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
