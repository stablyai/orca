import { useCallback } from 'react'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { buildHostLabelById } from '../../../src/shared/worktree/host-context-labels'
import { repoColor } from '../worktree/repo-color'
import { buildRepoHostIdByRepoId } from '../worktree/worktree-host-context-labels'
import type { HostWorkspaceOperations } from '../worktree/host-workspace-operations'
import type { HybridHostScreenState } from './use-hybrid-host-screen-state'

const REPO_METADATA_REFRESH_MS = 60_000

export function useHybridHostRepoMetadata(args: {
  operations: HostWorkspaceOperations | null
  connState: string
  hostId: string | undefined
  hostState: { cacheRepositories(hostId: string, repositories: readonly unknown[]): void }
  state: HybridHostScreenState
}) {
  const { operations, connState, hostId, hostState, state } = args
  // Why: `state` is a fresh object every render. Listing it as a dependency re-created this
  // callback per render, which re-armed the catalog refresh effect, whose fetch set state and
  // rendered again: a self-sustaining request loop the shell then rate-limited. Only the stable
  // refs and setters it uses may be dependencies.
  const {
    fetchRepoMetadataInFlightRef,
    fetchRepoMetadataPendingRef,
    repoMetadataFetchedAtRef,
    setHostLabelById,
    setHostPlatform,
    setRepoColorsByName,
    setRepoHostIdByRepoId,
    setRepoIconsByName,
    setRepoIdsByName,
    workspaceOperationsRef
  } = state
  return useCallback(
    async (options: { force?: boolean; queueIfInFlight?: boolean } = {}) => {
      if (!operations || connState !== 'connected' || !hostId) {
        return
      }
      if (fetchRepoMetadataInFlightRef.current.has(operations)) {
        if (options.queueIfInFlight) {
          fetchRepoMetadataPendingRef.current.add(operations)
        }
        return
      }
      if (
        !options.force &&
        Date.now() - repoMetadataFetchedAtRef.current < REPO_METADATA_REFRESH_MS
      ) {
        return
      }
      fetchRepoMetadataInFlightRef.current.add(operations)
      const request = operations,
        requestHostId = hostId
      try {
        do {
          fetchRepoMetadataPendingRef.current.delete(request)
          const repos = await request.listRepos()
          if (workspaceOperationsRef.current !== request || hostId !== requestHostId) {
            return
          }
          repoMetadataFetchedAtRef.current = Date.now()
          hostState.cacheRepositories(requestHostId, repos)
          setRepoColorsByName(
            new Map(
              repos.map((repo) => [
                repo.displayName,
                repo.badgeColor || repoColor(repo.displayName)
              ])
            )
          )
          setRepoIconsByName(
            new Map(
              repos.flatMap((repo) =>
                repo.repoIcon ? [[repo.displayName, repo.repoIcon] as const] : []
              )
            )
          )
          setRepoIdsByName(new Map(repos.map((repo) => [repo.displayName, repo.id])))
          setRepoHostIdByRepoId(buildRepoHostIdByRepoId(repos))
          // Why: rows only name their host when the list spans hosts, so a single-host
          // catalog never pays for the label lookups. Counted over repos, not the id-keyed
          // map: one repo id registered on two hosts is two hosts.
          const hostIds = new Set(repos.map((repo) => getRepoExecutionHostId(repo)))
          if (hostIds.size > 1 && request.listHostContext) {
            const context = await request.listHostContext()
            if (workspaceOperationsRef.current !== request || hostId !== requestHostId) {
              return
            }
            setHostLabelById(buildHostLabelById(context))
            setHostPlatform(context.platform)
          }
        } while (fetchRepoMetadataPendingRef.current.has(request))
      } catch {
        // Repo metadata is optional; catalog rows still render without it.
      } finally {
        fetchRepoMetadataInFlightRef.current.delete(request)
      }
    },
    [
      operations,
      connState,
      hostId,
      hostState,
      fetchRepoMetadataInFlightRef,
      fetchRepoMetadataPendingRef,
      repoMetadataFetchedAtRef,
      setHostLabelById,
      setHostPlatform,
      setRepoColorsByName,
      setRepoHostIdByRepoId,
      setRepoIconsByName,
      setRepoIdsByName,
      workspaceOperationsRef
    ]
  )
}
