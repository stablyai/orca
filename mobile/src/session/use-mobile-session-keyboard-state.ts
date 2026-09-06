import { useEffect, useCallback } from 'react'
import { useTerminalViewportRefit } from '../terminal/terminal-viewport-refit'
import type { CustomKey } from '../components/CustomKeyModal'
import { resolveTabStripScrollOffset } from './tab-strip-scroll'
import type { MobileSessionLifecycleModel } from './use-mobile-session-lifecycle'
import { persistSessionLastVisitedWorktree } from './session-last-visited-worktree'

export function useMobileSessionKeyboardState(scope: MobileSessionLifecycleModel) {
  const {
    hostId,
    worktreeId,
    connState,
    terminals,
    terminalTextScale,
    activeSessionTabId,
    tabStripRef,
    tabStripOffsetRef,
    tabStripViewportWidthRef,
    tabStripContentWidthRef,
    tabLayoutsRef,
    customKeys,
    setCustomKeys,
    setShowCustomKeyModal,
    deviceTokenRef,
    clientRef,
    viewportRef,
    viewportMeasuredRef,
    terminalRefs,
    initializedHandlesRef,
    activeHandleRef,
    terminalFrameHeightRef,
    terminalFrameWidth,
    showNativeChatRef,
    unsubscribeTerminal,
    subscribeToTerminal,
    keyboardHeight,
    sessionDeviceOperations,
    terminalSettingsModalHandoffRef
  } = scope
  // Why: non-subscribe layout refits (tab strip, fold, rotation) live in a dedicated hook — see terminal-viewport-refit.ts.
  const { notifyTerminalFrameHeight, notifyKeyboardVisibility } = useTerminalViewportRefit({
    activeHandleRef,
    terminalRefs,
    terminalFrameHeightRef,
    viewportRef,
    viewportMeasuredRef,
    nativeChatCoveredRef: showNativeChatRef,
    clientRef,
    deviceTokenRef,
    initializedHandlesRef,
    connState,
    tabStripVisible: terminals.length > 1,
    textScale: terminalTextScale,
    terminalFrameWidth,
    unsubscribeTerminal,
    subscribeToTerminal
  })

  useEffect(() => {
    notifyKeyboardVisibility(keyboardHeight > 0)
  }, [keyboardHeight, notifyKeyboardVisibility])

  const scrollActiveTabIntoView = useCallback((tabId: string | null, animated: boolean) => {
    if (!tabId) {
      return
    }
    const layout = tabLayoutsRef.current.get(tabId)
    if (!layout) {
      return
    }
    const nextOffset = resolveTabStripScrollOffset({
      tabX: layout.x,
      tabWidth: layout.width,
      viewportWidth: tabStripViewportWidthRef.current,
      contentWidth: tabStripContentWidthRef.current,
      currentOffset: tabStripOffsetRef.current
    })
    if (nextOffset !== tabStripOffsetRef.current) {
      tabStripOffsetRef.current = nextOffset
      tabStripRef.current?.scrollTo({ x: nextOffset, animated })
    }
  }, [])

  // Reveal the active tab on change; defer one frame so freshly mounted tab layouts are recorded.
  useEffect(() => {
    const id = requestAnimationFrame(() => scrollActiveTabIntoView(activeSessionTabId, true))
    return () => cancelAnimationFrame(id)
  }, [activeSessionTabId, scrollActiveTabIntoView])

  useEffect(() => {
    if (hostId && worktreeId) {
      void persistSessionLastVisitedWorktree(hostId, worktreeId)
    }
  }, [hostId, worktreeId])

  const handleDeleteCustomKey = useCallback(
    async (key: CustomKey) => {
      const updated = customKeys.filter((k) => k.id !== key.id)
      setCustomKeys(updated)
      await sessionDeviceOperations?.saveTerminalCustomKeys(updated)
    },
    [customKeys, sessionDeviceOperations]
  )

  const handleManageShortcuts = useCallback(() => {
    terminalSettingsModalHandoffRef.current.request(() => setShowCustomKeyModal(false))
  }, [])
  const handleCustomKeyModalAfterClose = useCallback(() => {
    terminalSettingsModalHandoffRef.current.complete(() =>
      sessionDeviceOperations?.openTerminalSettings()
    )
  }, [sessionDeviceOperations])
  return {
    notifyTerminalFrameHeight,
    notifyKeyboardVisibility,
    scrollActiveTabIntoView,
    handleDeleteCustomKey,
    handleManageShortcuts,
    handleCustomKeyModalAfterClose
  }
}

export type MobileSessionKeyboardStateModel = MobileSessionLifecycleModel &
  ReturnType<typeof useMobileSessionKeyboardState>
