import { useRef, useCallback } from 'react'
import { Keyboard, type View } from 'react-native'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import type {
  TerminalKeyboardAvoidanceMetrics,
  TerminalModes
} from '../terminal/terminal-webview-contract'
import type { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import {
  createTerminalAccessoryRepeatController,
  createTerminalAccessoryRepeatSender
} from '../terminal/terminal-accessory-repeat'
import { clearTerminalLiveInputFocusTimer } from '../terminal/terminal-live-input'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'
import type { RuntimeRepoSummary } from './mobile-session-route-types'
import type { MobileSessionTerminalInputModel } from './use-mobile-session-terminal-input'
import { mobileLogErrorKind } from '../diagnostics/mobile-log-error-kind'

export function useMobileSessionAccessorySelection(scope: MobileSessionTerminalInputModel) {
  const {
    worktreeId,
    isFloatingWorkspaceRoute,
    client,
    setTerminalKeyboardMetrics,
    setSelectModeActive,
    setCanPaste,
    toastSeqRef,
    ptyModesRef,
    initialModesSeenRef,
    terminalRefs,
    liveInputFocusTimerRef,
    sessionTabActionSheetRequestSeqRef,
    activeHandleRef,
    clientRef,
    connStateRef,
    clearPendingLiveInputCommit,
    clearDelayedActionTimers,
    clearToastHideTimer,
    showToast,
    clearTerminalCache,
    handleAccessoryKey,
    clearSessionTabActionSheetKeyboardListener,
    copyTextToDevice,
    sessionDeviceOperations,
    triggerError,
    triggerSuccess
  } = scope
  const accessoryRepeatRef = useRef(
    createTerminalAccessoryRepeatController<ReturnType<typeof createTerminalLiveAccessoryInput>>()
  )
  // Why: the current callback observes reconnect state while the sender pins the press to its original terminal.
  const handleAccessoryKeyRef = useRef(handleAccessoryKey)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  handleAccessoryKeyRef.current = handleAccessoryKey
  const stopAccessoryRepeat = useCallback(() => {
    accessoryRepeatRef.current.stop()
  }, [])
  const startAccessoryRepeat = useCallback(
    (input: ReturnType<typeof createTerminalLiveAccessoryInput>) => {
      // Why: a held repeat must not resume through a replacement client or connection.
      const targetClient = clientRef.current
      const targetConnectedAt = targetClient?.getLastConnectedAt() ?? null
      const isDeliveryTargetCurrent = (targetHandle: string) =>
        activeHandleRef.current === targetHandle &&
        targetClient !== null &&
        clientRef.current === targetClient &&
        connStateRef.current === 'connected' &&
        targetClient.getLastConnectedAt() === targetConnectedAt
      accessoryRepeatRef.current.start(
        input,
        createTerminalAccessoryRepeatSender(
          activeHandleRef.current,
          isDeliveryTargetCurrent,
          (nextInput, targetHandle, isTargetCurrent) =>
            handleAccessoryKeyRef.current(nextInput, targetHandle, isTargetCurrent)
        )
      )
    },
    []
  )
  const setMobileSessionRootRef = useCallback(
    (node: View | null): void => {
      if (node !== null) {
        return
      }
      // Why: clear only on real route detach; client churn during mount would wipe xterm state mid-subscribe.
      toastSeqRef.current += 1
      clearTerminalCache()
      clearToastHideTimer()
      clearDelayedActionTimers()
      clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)
      clearPendingLiveInputCommit()
      sessionTabActionSheetRequestSeqRef.current += 1
      clearSessionTabActionSheetKeyboardListener()
      stopAccessoryRepeat()
    },
    [
      clearPendingLiveInputCommit,
      clearDelayedActionTimers,
      clearSessionTabActionSheetKeyboardListener,
      clearTerminalCache,
      clearToastHideTimer,
      stopAccessoryRepeat
    ]
  )

  const handleSelectionMode = useCallback((handle: string, active: boolean) => {
    if (handle !== activeHandleRef.current) {
      return
    }
    setSelectModeActive(active)
    if (active) {
      Keyboard.dismiss()
    }
  }, [])

  const handleSelectionCopy = useCallback(
    async (handle: string, text: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      if (!text || text.length === 0) {
        terminalRefs.current.get(handle)?.cancelSelect()
        return
      }
      try {
        const result = await copyTextToDevice(text)
        triggerSuccess()
        // Why: Android 13+ shows its own system copy toast; iOS shows none, so only iOS needs our in-app toast.
        if (result.confirmation === 'in-app') {
          showToast('Copied')
        }
        terminalRefs.current.get(handle)?.cancelSelect()
      } catch (e) {
        triggerError()
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] setString failed', {
          kind: mobileLogErrorKind(e)
        })
        showToast("Couldn't copy", 1500)
      }
    },
    [copyTextToDevice, showToast, triggerError, triggerSuccess]
  )

  const handleSelectionEvicted = useCallback(
    (handle: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      // eslint-disable-next-line no-console
      console.warn('[mobile-clip] selection evicted')
      showToast('Selection cleared (scrolled out of buffer)', 1500)
      setSelectModeActive(false)
    },
    [showToast]
  )

  const handleModesChanged = useCallback((handle: string, modes: TerminalModes) => {
    ptyModesRef.current.set(handle, modes)
    initialModesSeenRef.current.add(handle)
  }, [])

  const handleKeyboardAvoidanceMetrics = useCallback(
    (handle: string, metrics: TerminalKeyboardAvoidanceMetrics) => {
      setTerminalKeyboardMetrics((prev) => {
        const current = prev.get(handle)
        if (
          current &&
          current.cursorY === metrics.cursorY &&
          current.contentBottomRow === metrics.contentBottomRow &&
          current.rows === metrics.rows &&
          current.altScreen === metrics.altScreen
        ) {
          return prev
        }
        return new Map(prev).set(handle, metrics)
      })
    },
    []
  )

  const handleHaptic = useCallback(
    (kind: 'selection' | 'success' | 'error' | 'edge-bump') => {
      sessionDeviceOperations?.hapticFeedback(kind)
    },
    [sessionDeviceOperations]
  )

  const getActiveWorktreeConnectionId = useCallback(async (): Promise<string | null> => {
    // Why: the floating workspace always runs on the paired host itself, never an SSH repo target.
    if (!client || isFloatingWorkspaceRoute) {
      return null
    }
    const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
    const repoResponse = await client.sendRequest('repo.list')
    if (!repoResponse.ok) {
      throw new Error((repoResponse as RpcFailure).error.message)
    }
    const repos =
      ((repoResponse as RpcSuccess).result as { repos?: RuntimeRepoSummary[] }).repos ?? []
    return repos.find((repo) => repo.id === repoId)?.connectionId?.trim() || null
  }, [client, isFloatingWorkspaceRoute, worktreeId])

  const refreshCanPaste = useCallback(() => {
    void sessionDeviceOperations
      ?.clipboardAvailability()
      .then(({ hasText, hasImage }) => setCanPaste(hasText || hasImage))
      .catch(() => setCanPaste(false))
  }, [sessionDeviceOperations])
  return {
    handleAccessoryKeyRef,
    stopAccessoryRepeat,
    startAccessoryRepeat,
    setMobileSessionRootRef,
    handleSelectionMode,
    handleSelectionCopy,
    handleSelectionEvicted,
    handleModesChanged,
    handleKeyboardAvoidanceMetrics,
    handleHaptic,
    getActiveWorktreeConnectionId,
    refreshCanPaste
  }
}

export type MobileSessionAccessorySelectionModel = MobileSessionTerminalInputModel &
  ReturnType<typeof useMobileSessionAccessorySelection>
