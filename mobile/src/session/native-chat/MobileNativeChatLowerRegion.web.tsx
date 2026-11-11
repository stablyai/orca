import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import {
  MobileNativeChatLowerRegionContext,
  MobileNativeChatLowerGeometryContext,
  MobileNativeChatComposerPresenceContext
} from './mobile-native-chat-lower-region-context'
import { connectMobileNativeChatLowerScroll } from './mobile-native-chat-lower-scroll'

export function MobileNativeChatLowerRegion({
  children,
  composerPresent = true,
  scopeKey
}: {
  children: ReactNode
  composerPresent?: boolean
  scopeKey?: string
}) {
  const scrollRef = useRef<ScrollView>(null)
  const contentRef = useRef<View>(null)
  const coordinator = useRef<ReturnType<typeof connectMobileNativeChatLowerScroll> | null>(null)
  const [geometry, setGeometry] = useState<{
    viewportHeight: number
    allocationHeight: number | null
  }>({ viewportHeight: 0, allocationHeight: null })
  const getViewport = useCallback((): unknown => scrollRef.current?.getScrollableNode(), [])
  const getContent = useCallback((): unknown => contentRef.current, [])
  const getRoot = useCallback((): unknown => {
    const viewport = getViewport()
    return viewport instanceof HTMLElement
      ? viewport.closest('[data-testid="native-chat-view"]')
      : null
  }, [getViewport])
  const reveal = useCallback(
    (group?: unknown, reason?: 'focus' | 'edit' | 'menu') =>
      coordinator.current?.reveal(group, reason),
    []
  )
  const layoutChanged = useCallback(() => coordinator.current?.layoutChanged(), [])
  const value = useMemo(
    () => ({ getViewport, getContent, getRoot, reveal, layoutChanged }),
    [getViewport, getContent, getRoot, reveal, layoutChanged]
  )
  useLayoutEffect(() => {
    const viewport = getViewport()
    const content = getContent()
    if (!(viewport instanceof HTMLElement) || !(content instanceof HTMLElement)) {
      return
    }
    const connected = connectMobileNativeChatLowerScroll(
      viewport,
      content,
      (viewportHeight, allocationHeight) => {
        setGeometry((current) =>
          current.viewportHeight === viewportHeight && current.allocationHeight === allocationHeight
            ? current
            : { viewportHeight, allocationHeight }
        )
      }
    )
    coordinator.current = connected
    return () => {
      coordinator.current = null
      connected.dispose()
    }
  }, [getViewport, getContent, scopeKey])
  useLayoutEffect(layoutChanged)
  return (
    <MobileNativeChatLowerRegionContext value={value}>
      <MobileNativeChatLowerGeometryContext value={geometry}>
        <MobileNativeChatComposerPresenceContext value={composerPresent}>
          <ScrollView
            ref={scrollRef}
            testID="native-chat-lower-scroll"
            style={{ flexGrow: 0, flexShrink: 1, minHeight: 0 }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}
            keyboardShouldPersistTaps="always"
            nestedScrollEnabled
          >
            <View ref={contentRef}>{children}</View>
          </ScrollView>
        </MobileNativeChatComposerPresenceContext>
      </MobileNativeChatLowerGeometryContext>
    </MobileNativeChatLowerRegionContext>
  )
}
