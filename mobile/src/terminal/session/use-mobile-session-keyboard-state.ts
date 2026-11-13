import { useEffect, useCallback } from 'react'
import {
  currentSoftKeyboardHeight,
  subscribeSoftKeyboard
} from '../../platform/keyboard/keyboard-occlusion'
import { useTerminalViewportRefit } from '../terminal-viewport-refit'
import { removeCustomKey, type CustomKey } from '../terminal-custom-keys'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { writeLastVisitedWorktree } from '../../worktree/last-visited-worktree-by-host'
import type { MobileSessionLifecycleModel } from '../../session/use-mobile-session-lifecycle'

export type MobileSessionKeyboardScope = Pick<
  MobileSessionLifecycleModel,
  | 'activeHandleRef'
  | 'visibleTerminalHandlesRef'
  | 'terminalPaneViewportsRef'
  | 'clientRef'
  | 'connState'
  | 'deviceTokenRef'
  | 'hostId'
  | 'router'
  | 'setCustomKeys'
  | 'setShowCustomKeyModal'
  | 'showNativeChatRef'
  | 'subscribeToTerminal'
  | 'terminalFrameRef'
  | 'terminalRefs'
  | 'terminals'
  | 'terminalTextScale'
  | 'unsubscribeTerminal'
  | 'viewportMeasuredRef'
  | 'viewportRef'
  | 'worktreeId'
>

export function useMobileSessionKeyboardState(scope: MobileSessionKeyboardScope) {
  const {
    hostId,
    worktreeId,
    router,
    connState,
    terminals,
    terminalTextScale,
    setCustomKeys,
    setShowCustomKeyModal,
    deviceTokenRef,
    clientRef,
    viewportRef,
    viewportMeasuredRef,
    terminalRefs,
    activeHandleRef,
    visibleTerminalHandlesRef,
    terminalPaneViewportsRef,
    terminalFrameRef,
    showNativeChatRef,
    unsubscribeTerminal,
    subscribeToTerminal
  } = scope
  const {
    notifyTerminalFrameHeight,
    notifyTerminalFrameWidth,
    notifyKeyboardVisibility,
    notifyTerminalCellBoxChange
  } = useTerminalViewportRefit({
    activeHandleRef,
    visibleTerminalHandlesRef,
    terminalPaneViewportsRef,
    terminalRefs,
    terminalFrameRef,
    viewportRef,
    viewportMeasuredRef,
    nativeChatCoveredRef: showNativeChatRef,
    clientRef,
    deviceTokenRef,
    connState,
    tabStripVisible: terminals.length > 1,
    textScale: terminalTextScale,
    unsubscribeTerminal,
    subscribeToTerminal
  })

  // Use the keyboard seam because web Keyboard emits nothing; visibility goes out with the event, before the lift renders, so refits defer while it opens.
  useEffect(() => {
    notifyKeyboardVisibility(currentSoftKeyboardHeight() > 0)
    return subscribeSoftKeyboard(
      () => notifyKeyboardVisibility(true),
      () => notifyKeyboardVisibility(false)
    )
  }, [notifyKeyboardVisibility])

  const executionHost = useWorkspaceExecutionHost()
  useEffect(() => {
    if (hostId && worktreeId) {
      void writeLastVisitedWorktree({ hostId, worktreeId, executionHost })
    }
  }, [hostId, worktreeId, executionHost])

  const handleDeleteCustomKey = useCallback(async (key: CustomKey) => {
    try {
      setCustomKeys(await removeCustomKey(key.id))
    } catch (error) {
      console.warn('[custom-keys] the store would not take this removal', error)
    }
  }, [])

  const handleManageShortcuts = useCallback(() => {
    setShowCustomKeyModal(false)
    router.push('/terminal-settings')
  }, [router])
  return {
    notifyTerminalFrameHeight,
    notifyTerminalFrameWidth,
    notifyKeyboardVisibility,
    notifyTerminalCellBoxChange,
    handleDeleteCustomKey,
    handleManageShortcuts
  }
}

export type MobileSessionKeyboardStateModel = MobileSessionLifecycleModel &
  ReturnType<typeof useMobileSessionKeyboardState>
