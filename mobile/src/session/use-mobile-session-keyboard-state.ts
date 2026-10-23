import { useEffect, useCallback, useRef } from 'react'
import { useSoftKeyboard } from '../platform/keyboard-occlusion'
import { useTerminalViewportRefit } from '../terminal/terminal-viewport-refit'
import { removeCustomKey, type CustomKey } from '../terminal/terminal-custom-keys'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { writeLastVisitedWorktree } from '../worktree/last-visited-worktree-by-host'
import { resolveTabStripScrollOffset } from './tab-strip-scroll'
import type { MobileSessionLifecycleModel } from './use-mobile-session-lifecycle'

/**
 * Exactly the fields this hook reads, so the whole lifecycle model still fits and a test can build
 * one. Most of them are forwarded to the viewport refit; the rest are named where they are used.
 */
export type MobileSessionKeyboardScope = Pick<
  MobileSessionLifecycleModel,
  | 'activeHandleRef'
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
    terminalFrameRef,
    showNativeChatRef,
    unsubscribeTerminal,
    subscribeToTerminal
  } = scope
  // Why: non-subscribe layout refits (tab strip, fold, rotation) live in a dedicated hook — see terminal-viewport-refit.ts.
  const {
    notifyTerminalFrameHeight,
    notifyTerminalFrameWidth,
    notifyKeyboardVisibility,
    notifyTerminalCellBoxChange
  } = useTerminalViewportRefit({
    activeHandleRef,
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

  // Why: react-native-web's `Keyboard` never fires, so inside the shell's page this screen heard no
  // keyboard at all — the platform seam answers on both hosts. Visibility before height, as the
  // listeners had it: the flag is what defers the refit the height change would otherwise trigger.
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
  // Why: a double-tap's second tap must land on the tab the first one hit, so a tap's reveal waits
  // out that window and every other strip scroll, activation's included, holds until it runs.
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

  // Reveal the active tab on change; defer one frame so freshly mounted tab layouts are recorded.
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
