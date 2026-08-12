import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { isMobileNativeChatTranscriptReadable } from './mobile-native-chat-eligibility'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'

type RepoSummary = { id: string; connectionId?: string | null }
type ReadabilityState = { client: RpcClient | null; worktreeId: string; readable: boolean }

export function useMobileNativeChatReadability(
  client: RpcClient | null,
  worktreeId: string
): boolean {
  const isFloatingWorkspace = isFloatingWorkspaceWorktreeId(worktreeId)
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
    if (!client) {
      setState({ client, worktreeId, readable: false })
      return
    }
    void client
      .sendRequest('repo.list')
      .then((response) => {
        if (!active) {
          return
        }
        const repos = response.ok
          ? ((response.result as { repos?: RepoSummary[] }).repos ?? [])
          : []
        const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
        const repo = repos.find((candidate) => candidate.id === repoId)
        setState({
          client,
          worktreeId,
          readable: repo ? isMobileNativeChatTranscriptReadable(repo.connectionId ?? null) : false
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
  }, [client, isFloatingWorkspace, worktreeId])
  if (isFloatingWorkspace) {
    return true
  }
  // Why: route reuse renders before its new effect resolves; never expose the
  // previous repo's readability under a different client/worktree key.
  return state.client === client && state.worktreeId === worktreeId ? state.readable : false
}
