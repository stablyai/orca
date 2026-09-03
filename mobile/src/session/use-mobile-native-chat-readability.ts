import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { isMobileNativeChatTranscriptReadable } from './mobile-native-chat-eligibility'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'

type RepoSummary = { id: string; connectionId?: string | null }
type FolderWorkspaceSummary = { id: string; connectionId: string | null }
type ReadabilityState = { client: RpcClient | null; worktreeId: string; readable: boolean }

function resolveFolderWorkspaceSummary(
  catalog: unknown,
  workspaceId: string
): FolderWorkspaceSummary | null {
  if (!Array.isArray(catalog)) {
    return null
  }
  const matches = catalog.filter(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { id?: unknown }).id === workspaceId
  )
  if (matches.length !== 1) {
    return null
  }
  const connectionId = (matches[0] as { connectionId?: unknown }).connectionId
  return connectionId === null || typeof connectionId === 'string'
    ? { id: workspaceId, connectionId }
    : null
}

export function useMobileNativeChatReadability(
  client: RpcClient | null,
  worktreeId: string
): boolean {
  const isFloatingWorkspace = isFloatingWorkspaceWorktreeId(worktreeId)
  const isFolderWorkspace = worktreeId.startsWith('folder:')
  const folderWorkspaceId = isFolderWorkspace ? worktreeId.slice('folder:'.length) : null
  const [state, setState] = useState<ReadabilityState>({
    client: null,
    worktreeId: '',
    readable: false
  })
  useEffect(() => {
    // Why: the floating workspace always runs on the paired host and has no repo connection to resolve.
    if (isFloatingWorkspace) {
      return
    }
    let active = true
    if (!client || (folderWorkspaceId !== null && folderWorkspaceId.trim().length === 0)) {
      setState({ client, worktreeId, readable: false })
      return
    }
    void client
      .sendRequest(isFolderWorkspace ? 'folderWorkspace.list' : 'repo.list')
      .then((response) => {
        if (!active) {
          return
        }
        const workspaceId =
          folderWorkspaceId !== null ? folderWorkspaceId : getRepoIdFromMobileWorktreeId(worktreeId)
        const workspace = response.ok
          ? folderWorkspaceId !== null
            ? resolveFolderWorkspaceSummary(
                (response.result as { folderWorkspaces?: unknown }).folderWorkspaces,
                workspaceId
              )
            : ((response.result as { repos?: RepoSummary[] }).repos ?? []).find(
                (candidate) => candidate.id === workspaceId
              )
          : null
        setState({
          client,
          worktreeId,
          readable: workspace
            ? isMobileNativeChatTranscriptReadable(workspace.connectionId ?? null)
            : false
        })
      })
      .catch(() => {
        if (active) {
          setState({ client, worktreeId, readable: false })
        }
      })
    return () => {
      active = false
    }
  }, [client, folderWorkspaceId, isFloatingWorkspace, isFolderWorkspace, worktreeId])
  if (isFloatingWorkspace) {
    return true
  }
  // Why: route reuse renders before its new effect resolves; never expose the
  // previous repo's readability under a different client/worktree key.
  return state.client === client && state.worktreeId === worktreeId ? state.readable : false
}
