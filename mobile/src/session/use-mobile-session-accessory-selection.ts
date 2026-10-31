import { useRef, useCallback, useEffect, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import { AppState, Keyboard, Platform, type View } from 'react-native'
import {
  createTerminalAccessoryRepeatController,
  createTerminalAccessoryRepeatSender
} from '../terminal/terminal-accessory-repeat'
import { useClipboardReader, useClipboardWriter } from '../platform/clipboard'
import { translate } from '../i18n/mobile-i18n'
import { newTabRepoListRead, type MobileRuntimeRepoSummary } from './mobile-session-read-operations'
import {
  triggerSelection,
  triggerSuccess,
  triggerError,
  triggerEdgeBump
} from '../platform/haptics'
import {
  sameTerminalKeyboardAvoidanceMetrics,
  type TerminalKeyboardAvoidanceMetrics,
  type TerminalModes
} from '../terminal/terminal-webview-contract'
import type { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { clearTerminalLiveInputFocusTimer } from '../terminal/terminal-live-input'
import { stripTerminalSelectionGutter } from '../../../src/shared/terminal-selection-gutter'
import { useTerminalCopyTrimsGutter } from '../terminal/terminal-copy-gutter-preference'
import type { MobileSessionTerminalInputModel } from './use-mobile-session-terminal-input'

export function useMobileSessionAccessorySelection(scope: MobileSessionTerminalInputModel) {
  const {
    worktreeId,
    isFloatingWorkspaceRoute,
    client,
    clientRef,
    connState,
    connStateRef,
    activeHandle,
    activeSessionTabTypeRef,
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
  const clipboard = useClipboardWriter()
  const clipboardContents = useClipboardReader().contents
  const trimsGutterRef = useTerminalCopyTrimsGutter(client, connState)
  const [accessoryRepeat] = useState(() =>
    createTerminalAccessoryRepeatController<ReturnType<typeof createTerminalLiveAccessoryInput>>()
  )
  const focusedRef = useRef(false)
  const repeatOwnerRevisionRef = useRef(0)
  // Repeats read the latest live-input mode; press-time ownership is fenced by the sender below.
  const handleAccessoryKeyRef = useRef(handleAccessoryKey)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  handleAccessoryKeyRef.current = handleAccessoryKey
  const stopAccessoryRepeat = useCallback(() => accessoryRepeat.stop(), [accessoryRepeat])
  const cancelAccessoryRepeat = useCallback(() => {
    repeatOwnerRevisionRef.current += 1
    accessoryRepeat.cancel()
  }, [accessoryRepeat])
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true
      return () => {
        focusedRef.current = false
        cancelAccessoryRepeat()
      }
    }, [cancelAccessoryRepeat])
  )
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        cancelAccessoryRepeat()
      }
    })
    return () => subscription.remove()
  }, [cancelAccessoryRepeat])
  useEffect(
    () => cancelAccessoryRepeat,
    [activeHandle, client, connState, worktreeId, cancelAccessoryRepeat]
  )
  const prepareAccessoryPress = useCallback(
    (input: ReturnType<typeof createTerminalLiveAccessoryInput>) => {
      const pressedClient = clientRef.current
      const pressedGeneration = pressedClient?.getGeneration?.() ?? 0
      const pressedRevision = repeatOwnerRevisionRef.current
      const sender = createTerminalAccessoryRepeatSender<
        ReturnType<typeof createTerminalLiveAccessoryInput>
      >(
        activeHandleRef.current,
        (handle) =>
          repeatOwnerRevisionRef.current === pressedRevision &&
          focusedRef.current &&
          AppState.currentState === 'active' &&
          clientRef.current === pressedClient &&
          (pressedClient?.getGeneration?.() ?? 0) === pressedGeneration &&
          connStateRef.current === 'connected' &&
          activeHandleRef.current === handle &&
          activeSessionTabTypeRef.current === 'terminal',
        (...args) => handleAccessoryKeyRef.current(...args)
      )
      let holdStarted = false
      return {
        tap: () => (holdStarted ? Promise.resolve(false) : sender(input)),
        hold: (firstRepeatDelayMs?: number) => {
          holdStarted = true
          accessoryRepeat.start(input, sender, firstRepeatDelayMs)
        }
      }
    },
    [accessoryRepeat]
  )
  const setMobileSessionRootRef = useCallback(
    (node: View | null): void => {
      if (node !== null) {
        return
      }
      // Clear xterm only on real route detach; client churn during mount must not wipe an active subscription.
      toastSeqRef.current += 1
      clearTerminalCache()
      clearToastHideTimer()
      clearDelayedActionTimers()
      clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)
      clearPendingLiveInputCommit()
      sessionTabActionSheetRequestSeqRef.current += 1
      clearSessionTabActionSheetKeyboardListener()
      cancelAccessoryRepeat()
    },
    [
      clearPendingLiveInputCommit,
      clearDelayedActionTimers,
      clearSessionTabActionSheetKeyboardListener,
      clearTerminalCache,
      clearToastHideTimer,
      cancelAccessoryRepeat
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
        await clipboard.writeText(
          trimsGutterRef.current ? stripTerminalSelectionGutter(text) : text
        )
        triggerSuccess()
        // Why: Android 13+ shows its own system copy toast; iOS shows none, so only iOS needs our in-app toast.
        if (Platform.OS === 'ios') {
          showToast(translate('common.copied', 'Copied'))
        }
        terminalRefs.current.get(handle)?.cancelSelect()
      } catch (e) {
        triggerError()
        const err = e as { name?: string; message?: string }
        console.warn('[mobile-clip] setString failed', {
          name: err.name,
          message: err.message
        })
        showToast(translate('session.useAccessorySelection.copyFailed', "Couldn't copy"), 1500)
      }
    },
    [clipboard, showToast]
  )

  const handleClipboardWrite = useCallback(
    async (handle: string, text: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      try {
        await clipboard.writeText(text)
      } catch {
        showToast(translate('session.useAccessorySelection.copyFailed', "Couldn't copy"), 1500)
      }
    },
    [activeHandleRef, clipboard, showToast]
  )

  const handleSelectionEvicted = useCallback(
    (handle: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      console.warn('[mobile-clip] selection evicted')
      showToast(
        translate(
          'session.useAccessorySelection.selectionCleared',
          'Selection cleared (scrolled out of buffer)'
        ),
        1500
      )
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
        if (current && sameTerminalKeyboardAvoidanceMetrics(current, metrics)) {
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
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const repoResponse = await newTabRepoListRead.request(client)
    const repos: MobileRuntimeRepoSummary[] = newTabRepoListRead.interpret(repoResponse)
    return repos.find((repo) => repo.id === repoId)?.connectionId?.trim() || null
  }, [client, isFloatingWorkspaceRoute, worktreeId])

  const refreshCanPaste = useCallback(() => {
    void clipboardContents().then(({ text, image }) => {
      setCanPaste(text || image)
    })
  }, [clipboardContents, setCanPaste])
  return {
    stopAccessoryRepeat,
    cancelAccessoryRepeat,
    prepareAccessoryPress,
    setMobileSessionRootRef,
    handleSelectionMode,
    handleSelectionCopy,
    handleSelectionEvicted,
    handleClipboardWrite,
    handleModesChanged,
    handleKeyboardAvoidanceMetrics,
    handleHaptic,
    getActiveWorktreeConnectionId,
    refreshCanPaste
  }
}

export type MobileSessionAccessorySelectionModel = MobileSessionTerminalInputModel &
  ReturnType<typeof useMobileSessionAccessorySelection>
