import { useEffect, useCallback, useRef } from 'react'
import { useSoftKeyboard } from '../platform/keyboard-occlusion'
import { useTerminalViewportRefit } from '../terminal/terminal-viewport-refit'
import { removeCustomKey, type CustomKey } from '../terminal/terminal-custom-keys'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { writeLastVisitedWorktree } from '../worktree/last-visited-worktree-by-host'
import { resolveTabStripScrollOffset } from './tab-strip-scroll'
import type { MobileSessionLifecycleModel } from './use-mobile-session-lifecycle'

export type MobileSessionKeyboardScope = Pick<
  MobileSessionLifecycleModel,
  | 'activeHandleRef'
  | 'visibleTerminalHandlesRef'
  | 'terminalPaneViewportsRef'
  | 'activeSessionTabId'
  | 'clientRef'
  | 'connState'
  | 'deviceTokenRef'
  | 'hostId'
  | 'router'
  | 'setCustomKeys'
  | 'setKeyboardHeight'
  | 'setShowCustomKeyModal'
  | 'showNativeChatRef'
  | 'subscribeToTerminal'
  | 'tabLayoutsRef'
  | 'tabStripContentWidthRef'
  | 'tabStripOffsetRef'
  | 'tabStripRef'
  | 'tabStripViewportWidthRef'
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
    activeSessionTabId,
    tabStripRef,
    tabStripOffsetRef,
    tabStripViewportWidthRef,
    tabStripContentWidthRef,
    tabLayoutsRef,
    setCustomKeys,
    setShowCustomKeyModal,
    setKeyboardHeight,
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

  // Use the keyboard seam because web Keyboard emits nothing; publish visibility before height so refits defer while it opens.
  const softKeyboard = useSoftKeyboard()
  useEffect(() => {
    notifyKeyboardVisibility(softKeyboard.visible)
  }, [notifyKeyboardVisibility, softKeyboard.visible])
  useEffect(() => {
    setKeyboardHeight(softKeyboard.height)
  }, [setKeyboardHeight, softKeyboard.height])

  const heldTabStripRevealRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelHeldTabStripReveal = useCallback(() => {
    if (heldTabStripRevealRef.current) {
      clearTimeout(heldTabStripRevealRef.current)
      heldTabStripRevealRef.current = null
    }
  }, [])
  useEffect(() => cancelHeldTabStripReveal, [cancelHeldTabStripReveal])
  // Hold strip movement through double-tap detection so its second tap reaches the same tab.
  const holdTabStripReveal = useCallback(
    (offset: number, delayMs: number) => {
      cancelHeldTabStripReveal()
      heldTabStripRevealRef.current = setTimeout(() => {
        heldTabStripRevealRef.current = null
        if (offset !== tabStripOffsetRef.current) {
          tabStripOffsetRef.current = offset
          tabStripRef.current?.scrollTo({ x: offset, animated: true })
        }
      }, delayMs)
    },
    [cancelHeldTabStripReveal]
  )

  const scrollActiveTabIntoView = useCallback((tabId: string | null, animated: boolean) => {
    if (!tabId || heldTabStripRevealRef.current) {
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

  useEffect(() => {
    const id = requestAnimationFrame(() => scrollActiveTabIntoView(activeSessionTabId, true))
    return () => cancelAnimationFrame(id)
  }, [activeSessionTabId, scrollActiveTabIntoView])

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
    scrollActiveTabIntoView,
    holdTabStripReveal,
    cancelHeldTabStripReveal,
    handleDeleteCustomKey,
    handleManageShortcuts
  }
}

export type MobileSessionKeyboardStateModel = MobileSessionLifecycleModel &
  ReturnType<typeof useMobileSessionKeyboardState>
