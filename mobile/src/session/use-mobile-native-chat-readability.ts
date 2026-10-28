import { useEffect, useState } from 'react'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import type { RpcClient } from '../transport/rpc-client'
import {
  nativeChatRepoListRead,
  type MobileRuntimeRepoSummary
} from './mobile-session-read-operations'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { resumeFolderWorkspaceListRead } from '../agent-history/mobile-agent-history-operations'
import { isMobileFolderNativeChatReadable } from './native-chat/mobile-native-chat-eligibility'
import { isNativeChatTranscriptLocalReadable } from '../../../src/shared/native-chat-transcript-readability'

type ReadabilityState = {
  client: RpcClient | null
  worktreeId: string
  readable: boolean
}

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
    if (isFloatingWorkspace) {
      return
    }
    let active = true
    if (!client) {
      setState({ client, worktreeId, readable: false })
      return
    }
    if (worktreeId.startsWith('folder:')) {
      void resumeFolderWorkspaceListRead
        .request(client)
        .then((response) => {
          if (!active) {
            return
          }
          const result = resumeFolderWorkspaceListRead.interpret(response)
          setState({
            client,
            worktreeId,
            readable: result.accepted && isMobileFolderNativeChatReadable(result.value, worktreeId)
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
    }
    void nativeChatRepoListRead
      .request(client)
      .then((response) => {
        if (!active) {
          return
        }
        const accepted = nativeChatRepoListRead.interpret(response)
        const repos: MobileRuntimeRepoSummary[] = accepted.accepted ? accepted.value : []
        const repoId = getRepoIdFromWorktreeId(worktreeId)
        const repo = repos.find((candidate) => candidate.id === repoId)
        setState({
          client,
          worktreeId,
          readable: repo ? isNativeChatTranscriptLocalReadable(repo.connectionId ?? null) : false
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
  // Route reuse precedes effect completion; never expose the prior repo’s verdict under a new scope.
  return state.client === client && state.worktreeId === worktreeId ? state.readable : false
}
