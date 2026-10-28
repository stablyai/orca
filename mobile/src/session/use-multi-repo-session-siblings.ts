import { useEffect, useState } from 'react'
import { MULTI_REPO_WORKSPACE_RUNTIME_CAPABILITY } from '../../../src/shared/worktree-runtime-capabilities'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { multiRepoSiblingListRead } from '../worktree/multi-repo-workspace-operations'
import {
  resolveMultiRepoSessionSiblings,
  type MultiRepoSessionSiblings
} from '../worktree/multi-repo-session-siblings'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
  worktreeId: string
}

export function useMultiRepoSessionSiblings({
  client,
  connState,
  hostCapabilities,
  worktreeId
}: Params): MultiRepoSessionSiblings | null {
  const [siblings, setSiblings] = useState<{
    worktreeId: string
    value: MultiRepoSessionSiblings | null
  } | null>(null)
  const supported = hostCapabilities.includes(MULTI_REPO_WORKSPACE_RUNTIME_CAPABILITY)

  useEffect(() => {
    if (!supported || !client || connState !== 'connected') {
      return
    }
    if (isFloatingWorkspaceWorktreeId(worktreeId)) {
      return
    }
    let stale = false
    void (async () => {
      try {
        const reply = await multiRepoSiblingListRead.request(client)
        const accepted = multiRepoSiblingListRead.interpret(reply)
        if (!stale && accepted.accepted) {
          setSiblings({
            worktreeId,
            value: resolveMultiRepoSessionSiblings(accepted.value, worktreeId)
          })
        }
      } catch {
        // The plain title stays when the sibling list cannot be read.
      }
    })()
    return () => {
      stale = true
    }
  }, [client, connState, supported, worktreeId])

  return siblings && siblings.worktreeId === worktreeId ? siblings.value : null
}
