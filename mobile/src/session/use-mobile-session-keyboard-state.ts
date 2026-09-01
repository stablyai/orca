import { useEffect, useCallback } from 'react'
import { Keyboard, Platform, type KeyboardEvent } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useTerminalViewportRefit } from '../terminal/terminal-viewport-refit'
import { saveCustomKeys, type CustomKey } from '../components/CustomKeyModal'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from '../worktree/last-visited-worktree-repo'
import { resolveTabStripScrollOffset } from './tab-strip-scroll'
import type { MobileSessionLifecycleModel } from './use-mobile-session-lifecycle'

export function useMobileSessionKeyboardState(scope: MobileSessionLifecycleModel) {
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

  useEffect(() => {
    const onShow = (e: KeyboardEvent) => {
      notifyKeyboardVisibility(true)
      setKeyboardHeight(e.endCoordinates?.height ?? 0)
    }
    const onHide = () => {
      notifyKeyboardVisibility(false)
      setKeyboardHeight(0)
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const showSub = Keyboard.addListener(showEvent, onShow)
    const hideSub = Keyboard.addListener(hideEvent, onHide)
    return () => {
      showSub.remove()
      hideSub.remove()
    }
  }, [notifyKeyboardVisibility])

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
      void AsyncStorage.setItem(
        LAST_VISITED_WORKTREE_STORAGE_KEY,
        JSON.stringify({ hostId, worktreeId })
      )
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
