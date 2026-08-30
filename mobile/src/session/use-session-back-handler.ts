import { useCallback, useEffect, type RefObject } from 'react'
import { BackHandler, Keyboard, type TextInput } from 'react-native'
import { useRouter } from 'expo-router'
import type {
  DirtyMarkdownDraft,
  MarkdownDocState,
  MobileSessionTab
} from './mobile-session-route-types'
import { createSessionBackPressHandler } from './session-back-press'

export function useSessionBackHandler({
  handleLiveInputKeyPress,
  hardwareKeyboard,
  hostId,
  liveInputRef,
  markdownDocs,
  sessionTabs,
  setLeaveDrafts
}: {
  handleLiveInputKeyPress: (event: { nativeEvent: { key: string } }) => void
  hardwareKeyboard: boolean
  hostId: string
  liveInputRef: RefObject<TextInput | null>
  markdownDocs: ReadonlyMap<string, MarkdownDocState>
  sessionTabs: readonly MobileSessionTab[]
  setLeaveDrafts: (drafts: DirtyMarkdownDraft[]) => void
}): { leaveSession: () => void; requestLeaveSession: () => void } {
  const router = useRouter()
  const leaveSession = useCallback(() => {
    if (router.canGoBack()) {
      router.back()
      return
    }
    // Why: Android back can fire at the root route; replace avoids React Navigation's dev-only GO_BACK warning.
    router.replace(`/h/${hostId}`)
  }, [hostId, router])
  const requestLeaveSession = useCallback(() => {
    const dirtyDrafts: DirtyMarkdownDraft[] = []
    for (const [tabId, doc] of markdownDocs) {
      if (doc.status === 'ready' && doc.isDirty) {
        const tab = sessionTabs.find((candidate) => candidate.id === tabId)
        dirtyDrafts.push({ tabId, title: tab?.title || 'Markdown', content: doc.localContent })
      }
    }
    if (dirtyDrafts.length === 0) {
      leaveSession()
      return
    }
    Keyboard.dismiss()
    setLeaveDrafts(dirtyDrafts)
  }, [leaveSession, markdownDocs, sessionTabs, setLeaveDrafts])

  useEffect(() => {
    const handleBackPress = createSessionBackPressHandler({
      hardwareKeyboard,
      isLiveInputFocused: () => liveInputRef.current?.isFocused() === true,
      requestLeave: requestLeaveSession,
      sendEscape: () => handleLiveInputKeyPress({ nativeEvent: { key: 'Escape' } })
    })
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress)
    return () => subscription.remove()
  }, [handleLiveInputKeyPress, hardwareKeyboard, liveInputRef, requestLeaveSession])

  return { leaveSession, requestLeaveSession }
}
