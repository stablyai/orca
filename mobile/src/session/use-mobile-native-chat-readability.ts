import { useEffect, useState } from 'react'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'

type ReadabilityState = {
  operations: HostSessionNativeChatOperations | null
  worktreeId: string
  readable: boolean
}

export function useMobileNativeChatReadability(
  operations: HostSessionNativeChatOperations | null,
  worktreeId: string
): boolean {
  const isFloatingWorkspace = isFloatingWorkspaceWorktreeId(worktreeId)
  const [state, setState] = useState<ReadabilityState>({
    operations: null,
    worktreeId: '',
    readable: false
  })
  useEffect(() => {
    // Why: the floating workspace always runs on the paired host and has no repo connection to resolve.
    if (isFloatingWorkspace) {
      return
    }
    let active = true
    if (!operations) {
      setState({ operations, worktreeId, readable: false })
      return
    }
    void operations
      .readability(worktreeId)
      .then((readable) => {
        if (!active) {
          return
        }
        setState({
          operations,
          worktreeId,
          readable
        })
      })
      .catch(() => {
        if (active) {
          setState({ operations, worktreeId, readable: false })
        }
      })
    return () => {
      active = false
    }
  }, [operations, isFloatingWorkspace, worktreeId])
  if (isFloatingWorkspace) {
    return true
  }
  // Why: route reuse renders before its new effect resolves; never expose the
  // previous repo's readability under a different client/worktree key.
  return state.operations === operations && state.worktreeId === worktreeId ? state.readable : false
}
