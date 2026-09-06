import { useRef, useCallback } from 'react'
import { Keyboard, Platform, type View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import {
  triggerSelection,
  triggerSuccess,
  triggerError,
  triggerEdgeBump
} from '../platform/haptics'
import type {
  TerminalKeyboardAvoidanceMetrics,
  TerminalModes
} from '../terminal/terminal-webview-contract'
import type { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { clearTerminalLiveInputFocusTimer } from '../terminal/terminal-live-input'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'
import type { RuntimeRepoSummary } from './mobile-session-route-types'
import type { MobileSessionTerminalInputModel } from './use-mobile-session-terminal-input'

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
    clearPendingLiveInputCommit,
    clearDelayedActionTimers,
    clearToastHideTimer,
    showToast,
    clearTerminalCache,
    handleAccessoryKey,
    clearSessionTabActionSheetKeyboardListener
  } = scope
  // Why: hold-to-repeat matches iOS cadence (400ms then 45ms); non-repeatable keys fire once (holding is destructive).
  const repeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Why: ref keeps repeat firing the current callback; else a mid-hold tab switch/reconnect routes bytes to a stale terminal.
  const handleAccessoryKeyRef = useRef(handleAccessoryKey)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  handleAccessoryKeyRef.current = handleAccessoryKey
  const stopAccessoryRepeat = useCallback(() => {
    if (repeatTimeoutRef.current) {
      clearTimeout(repeatTimeoutRef.current)
      repeatTimeoutRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
  }, [])
  const startAccessoryRepeat = useCallback(
    (input: ReturnType<typeof createTerminalLiveAccessoryInput>) => {
      stopAccessoryRepeat()
      repeatTimeoutRef.current = setTimeout(() => {
        repeatIntervalRef.current = setInterval(() => {
          void handleAccessoryKeyRef.current(input)
        }, 45)
      }, 400)
    },
    [stopAccessoryRepeat]
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
        await Clipboard.setStringAsync(text)
        triggerSuccess()
        // Why: Android 13+ shows its own system copy toast; iOS shows none, so only iOS needs our in-app toast.
        if (Platform.OS === 'ios') {
          showToast('Copied')
        }
        terminalRefs.current.get(handle)?.cancelSelect()
      } catch (e) {
        triggerError()
        const err = e as { name?: string; message?: string }
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] setString failed', {
          name: err.name,
          message: err.message
        })
        showToast("Couldn't copy", 1500)
      }
    },
    [showToast]
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

  const handleHaptic = useCallback((kind: 'selection' | 'success' | 'error' | 'edge-bump') => {
    if (kind === 'selection') {
      triggerSelection()
    } else if (kind === 'success') {
      triggerSuccess()
    } else if (kind === 'error') {
      triggerError()
    } else if (kind === 'edge-bump') {
      triggerEdgeBump()
    }
  }, [])

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
    void Promise.all([
      Clipboard.hasStringAsync().catch(() => false),
      Clipboard.hasImageAsync().catch(() => false)
    ]).then(([hasString, hasImage]) => {
      setCanPaste(hasString || hasImage)
    })
  }, [])
  return {
    repeatTimeoutRef,
    repeatIntervalRef,
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
