import { useEffect, useCallback } from 'react'
import { useSoftKeyboard } from '../platform/keyboard-occlusion'
import { useTerminalViewportRefit } from '../terminal/terminal-viewport-refit'
import { saveCustomKeys, type CustomKey } from '../components/CustomKeyModal'
import { writeLastVisitedWorktree } from '../worktree/last-visited-worktree-repo'
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
  | 'customKeys'
  | 'deviceTokenRef'
  | 'hostId'
  | 'initializedHandlesRef'
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
  | 'terminalFrameHeightRef'
  | 'terminalFrameWidth'
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
    customKeys,
    setCustomKeys,
    setShowCustomKeyModal,
    setKeyboardHeight,
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
    subscribeToTerminal
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
      writeLastVisitedWorktree({ hostId, worktreeId })
    }
  }, [hostId, worktreeId])

  const handleDeleteCustomKey = useCallback(
    async (key: CustomKey) => {
      const updated = customKeys.filter((k) => k.id !== key.id)
      setCustomKeys(updated)
      await saveCustomKeys(updated)
    },
    [customKeys]
  )

  const handleManageShortcuts = useCallback(() => {
    setShowCustomKeyModal(false)
    router.push('/terminal-settings')
  }, [router])
  return {
    notifyTerminalFrameHeight,
    notifyKeyboardVisibility,
    scrollActiveTabIntoView,
    handleDeleteCustomKey,
    handleManageShortcuts
  }
}

export type MobileSessionKeyboardStateModel = MobileSessionLifecycleModel &
  ReturnType<typeof useMobileSessionKeyboardState>
