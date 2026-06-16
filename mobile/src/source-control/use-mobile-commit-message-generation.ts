import { useCallback, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { cancelMobileCommitMessage, requestMobileCommitMessage } from './mobile-commit-message-ai'

type Params = {
  client: RpcClient | null
  worktreeId: string
  generatingMessage: boolean
  mountedRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  setGeneratingMessage: (next: boolean) => void
  setCommitMessage: (next: string) => void
  setActionError: (next: string | null) => void
}

// AI commit-message generation + cancellation. Split from the runners hook to
// keep each file under the line limit; behavior is unchanged.
export function useMobileCommitMessageGeneration(params: Params) {
  const {
    client,
    worktreeId,
    generatingMessage,
    mountedRef,
    busyActionRef,
    setGeneratingMessage,
    setCommitMessage,
    setActionError
  } = params

  // AI-generate a commit message from the staged diff. Matches desktop: the
  // button is always available; a missing model surfaces as a toast.
  const generateCommitMessage = useCallback(async () => {
    if (!client || generatingMessage || busyActionRef.current) {
      return
    }
    setGeneratingMessage(true)
    setActionError(null)
    try {
      const result = await requestMobileCommitMessage(client, worktreeId)
      if (!mountedRef.current) {
        return
      }
      if (result.success) {
        setCommitMessage(result.message)
        triggerSuccess()
      } else if (!result.canceled) {
        triggerError()
        setActionError(result.error)
      }
    } finally {
      if (mountedRef.current) {
        setGeneratingMessage(false)
      }
    }
  }, [
    busyActionRef,
    client,
    generatingMessage,
    mountedRef,
    setActionError,
    setCommitMessage,
    setGeneratingMessage,
    worktreeId
  ])

  const cancelGenerateCommitMessage = useCallback(() => {
    if (client) {
      void cancelMobileCommitMessage(client, worktreeId)
    }
  }, [client, worktreeId])

  return { generateCommitMessage, cancelGenerateCommitMessage }
}
