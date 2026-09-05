import { useCallback, useLayoutEffect, useRef, useReducer, useState, type RefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { TerminalStreamInputFailure } from '../transport/terminal-stream-input-failure'

type RecoveryOptions = {
  activeHandle: string | null
  client: RpcClient | null
  getSendCompletionGeneration: () => number
  getLiveInteractionGeneration: () => number
  activeHandleRef: RefObject<string | null>
  clientRef: RefObject<RpcClient | null>
  clearPendingLiveInputCommit: () => void
  unsubscribeTerminal: (handle: string) => void
  subscribeToTerminal: (handle: string) => void
  terminalInputSubscribedRef: RefObject<(handle: string) => void>
}

export function useTerminalInputRecovery(options: RecoveryOptions) {
  const [, refreshFailure] = useReducer((revision: number) => revision + 1, 0)
  const recoveryEpochRef = useRef(0)
  const [legacyFailure, setLegacyFailure] = useState<{ handle: string; client: RpcClient } | null>(
    null
  )
  const [unavailable, setUnavailable] = useState<{ handle: string; client: RpcClient } | null>(null)
  const recoveryRef = useRef<{
    handle: string
    client: RpcClient
    generation: number
    interaction: number
  } | null>(null)
  useLayoutEffect(() => {
    return () => {
      recoveryRef.current = null
    }
  }, [options.activeHandle, options.client])
  const reportTerminalInputFailure = useCallback(
    (handle: string, client: RpcClient, legacySendFailed = false) => {
      if (options.clientRef.current !== client || options.activeHandleRef.current !== handle) {
        return
      }
      const detail = client.getTerminalStreamInputFailure?.(handle)
      if (detail) {
        refreshFailure()
      } else if (legacySendFailed) {
        setLegacyFailure({ handle, client })
      }
    },
    [options.activeHandleRef, options.clientRef]
  )

  const recoverTerminalInput = useCallback(() => {
    const handle = options.activeHandleRef.current
    const client = options.clientRef.current
    if (!handle || !client) {
      return
    }
    recoveryEpochRef.current += 1
    setUnavailable(null)
    // Recovery never replays the optimistic field or assumes what reached the shell.
    options.clearPendingLiveInputCommit()
    client.cancelTerminalStreamInput?.(handle)
    options.unsubscribeTerminal(handle)
    recoveryRef.current = {
      handle,
      client,
      generation: options.getSendCompletionGeneration(),
      interaction: options.getLiveInteractionGeneration()
    }
    options.subscribeToTerminal(handle)
  }, [
    options.activeHandleRef,
    options.clientRef,
    options.clearPendingLiveInputCommit,
    options.unsubscribeTerminal,
    options.subscribeToTerminal,
    options.getSendCompletionGeneration,
    options.getLiveInteractionGeneration
  ])

  const captureTerminalInputFailureReporter = useCallback(
    (handle: string, client: RpcClient) => {
      const epoch = recoveryEpochRef.current
      const surface = options.getSendCompletionGeneration()
      return () => {
        if (
          epoch === recoveryEpochRef.current &&
          surface === options.getSendCompletionGeneration()
        ) {
          reportTerminalInputFailure(handle, client, true)
        }
      }
    },
    [options.getSendCompletionGeneration, reportTerminalInputFailure]
  )

  const handleSubscribed = useCallback(
    (handle: string) => {
      const recovery = recoveryRef.current
      if (
        !recovery ||
        recovery.handle !== handle ||
        options.activeHandleRef.current !== handle ||
        options.clientRef.current !== recovery.client ||
        options.getSendCompletionGeneration() !== recovery.generation ||
        options.getLiveInteractionGeneration() !== recovery.interaction
      ) {
        recoveryRef.current = null
        return
      }
      recoveryRef.current = null
      const legacyOnly =
        legacyFailure?.handle === handle &&
        legacyFailure.client === recovery.client &&
        !recovery.client.getTerminalStreamInputFailure?.(handle)
      if (recovery.client.recoverTerminalStreamInput?.(handle) || legacyOnly) {
        options.clearPendingLiveInputCommit()
        setLegacyFailure(null)
        refreshFailure()
      } else {
        setUnavailable(recovery)
        reportTerminalInputFailure(handle, recovery.client)
      }
    },
    [
      options.activeHandleRef,
      options.clientRef,
      options.getSendCompletionGeneration,
      options.getLiveInteractionGeneration,
      options.clearPendingLiveInputCommit,
      reportTerminalInputFailure,
      legacyFailure
    ]
  )

  useLayoutEffect(() => {
    options.terminalInputSubscribedRef.current = handleSubscribed
    return () => {
      options.terminalInputSubscribedRef.current = () => {}
    }
  }, [handleSubscribed, options.terminalInputSubscribedRef])

  const legacyDetail: TerminalStreamInputFailure | null =
    legacyFailure?.handle === options.activeHandle && legacyFailure?.client === options.client
      ? { outcome: 'unknown', reason: 'legacy_send_failed' }
      : null
  return {
    terminalInputRecoveryUnavailable:
      unavailable?.handle === options.activeHandle && unavailable?.client === options.client,
    terminalInputFailure: options.activeHandle
      ? (options.clientRef.current?.getTerminalStreamInputFailure?.(options.activeHandle) ??
        legacyDetail)
      : null,
    reportTerminalInputFailure,
    captureTerminalInputFailureReporter,
    recoverTerminalInput
  }
}
