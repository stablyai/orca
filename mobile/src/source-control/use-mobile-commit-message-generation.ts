import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
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
  setCommitMessage: Dispatch<SetStateAction<string>>
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
  const runRef = useRef(0)

  // AI-generate a commit message from the staged diff. Matches desktop: the
  // button is always available; a missing model surfaces as a toast.
  const generateCommitMessage = useCallback(async () => {
    if (!client || generatingMessage || busyActionRef.current) {
      return
    }
    runRef.current += 1
    const run = runRef.current
    setGeneratingMessage(true)
    setActionError(null)
    try {
      const result = await requestMobileCommitMessage(client, worktreeId)
      if (!mountedRef.current || run !== runRef.current) {
        return
      }
      if (result.success) {
        // Why: same rule as desktop — text typed while the agent ran wins over the generated message.
        setCommitMessage((current) => (current.length > 0 ? current : result.message))
        triggerSuccess()
      } else if (!result.canceled) {
        triggerError()
        setActionError(result.error)
      }
    } catch (err) {
      // Why: a transport drop rejects the RPC; without this the error haptic +
      // message are skipped and the rejection escapes the void-called handler.
      if (mountedRef.current && run === runRef.current) {
        triggerError()
        setActionError(err instanceof Error ? err.message : 'Failed to generate commit message')
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
    if (!client || !generatingMessage) {
      return
    }
    // Why: like desktop's canceled record — a run the host still finishes must not fill the box.
    runRef.current += 1
    // Why: commit and Create PR call this without awaiting; a dropped transport must not surface
    // as an unhandled rejection, and the run's own reply still clears the spinner.
    cancelMobileCommitMessage(client, worktreeId).catch(() => {})
  }, [client, generatingMessage, worktreeId])

  return { generateCommitMessage, cancelGenerateCommitMessage }
}
