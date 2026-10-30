import {
  useCallback,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { translate } from '../i18n/mobile-i18n'
import { cancelMobileCommitMessage, requestMobileCommitMessage } from './mobile-commit-message-ai'
import { textGenerationErrorText } from './text-generation-failure-copy'

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
  const activeRunRef = useRef<number | null>(null)
  const scopeRef = useRef({ client, worktreeId })
  useLayoutEffect(() => {
    if (scopeRef.current.client !== client || scopeRef.current.worktreeId !== worktreeId) {
      scopeRef.current = { client, worktreeId }
      runRef.current += 1
      activeRunRef.current = null
      setGeneratingMessage(false)
    }
  }, [client, worktreeId, setGeneratingMessage])

  const generateCommitMessage = useCallback(async () => {
    if (!client || generatingMessage || activeRunRef.current !== null || busyActionRef.current) {
      return
    }
    runRef.current += 1
    const run = runRef.current
    activeRunRef.current = run
    setGeneratingMessage(true)
    setActionError(null)
    try {
      const result = await requestMobileCommitMessage(client, worktreeId)
      if (!mountedRef.current || run !== runRef.current) {
        return
      }
      if (result.success) {
        // Text typed during generation wins over the generated message.
        setCommitMessage((current) => (current.length > 0 ? current : result.message))
        triggerSuccess()
      } else if (!result.canceled) {
        triggerError()
        setActionError(textGenerationErrorText(result))
      }
    } catch (err) {
      // Catch transport drops because callers void this handler; retain error feedback.
      if (mountedRef.current && run === runRef.current) {
        triggerError()
        setActionError(
          err instanceof Error
            ? err.message
            : translate(
                'sourceControl.useMobileCommitMessageGeneration.generateFailed',
                'Failed to generate commit message'
              )
        )
      }
    } finally {
      if (activeRunRef.current === run) {
        activeRunRef.current = null
        if (mountedRef.current) {
          setGeneratingMessage(false)
        }
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
    // Retire even a host run that finishes after cancellation so it cannot refill the box.
    runRef.current += 1
    // Commit/Create PR do not await cancellation; contain rejection and let the run’s reply clear the spinner.
    cancelMobileCommitMessage(client, worktreeId).catch(() => {})
  }, [client, generatingMessage, worktreeId])

  return { generateCommitMessage, cancelGenerateCommitMessage }
}
