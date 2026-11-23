import { useCallback, useRef } from 'react'
import {
  useMobileNativeChatTailFollow,
  type MobileScrollTailMetrics
} from '../../session/native-chat/transcript/viewport/use-mobile-native-chat-tail-follow'

/** What the page's ScrollView gives the follow. */
export type BotItemActivityScrollView = {
  scrollTo: (options: { y: number; animated: boolean }) => void
  scrollToEnd: (options: { animated: boolean }) => void
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void
}

/** Desktop's item follow: opens at the end of the activity, follows it there, holds a place scrolled up. */
export function useBotItemActivityFollow(args: { scopeKey: string; hasItems: boolean }) {
  const tail = useMobileNativeChatTailFollow(args)
  const scroll = useRef<BotItemActivityScrollView | null>(null)
  const offset = useRef(0)
  const viewHeight = useRef(0)
  const contentHeight = useRef(0)
  const attach = tail.listProps.ref
  const ref = useCallback(
    (view: BotItemActivityScrollView | null) => {
      scroll.current = view
      attach(
        view
          ? {
              scrollToEnd: (options) => view.scrollToEnd(options),
              scrollToOffset: ({ offset: y, animated }) => view.scrollTo({ y, animated })
            }
          : null
      )
    },
    [attach]
  )
  const record = tail.recordScrollMetrics
  const onScroll = useCallback(
    (event: { nativeEvent: MobileScrollTailMetrics }) => {
      offset.current = event.nativeEvent.contentOffset.y
      viewHeight.current = event.nativeEvent.layoutMeasurement.height
      contentHeight.current = event.nativeEvent.contentSize.height
      record(event.nativeEvent)
    },
    [record]
  )
  const pin = tail.pinToTailAfterContentResize
  const recheckEnd = useCallback(() => {
    if (viewHeight.current > 0 && contentHeight.current > 0) {
      record({
        contentOffset: { y: offset.current },
        contentSize: { height: contentHeight.current },
        layoutMeasurement: { height: viewHeight.current }
      })
    }
  }, [record])
  // Growth and a resized view (the keyboard) send no scroll event, so this rechecks the end, as
  // desktop's transcript resize does; a reader left above it then sees Scroll to latest.
  const onContentSizeChange = useCallback(
    (width: number, height: number) => {
      contentHeight.current = height
      pin(width, height)
      recheckEnd()
    },
    [pin, recheckEnd]
  )
  const pinOnLayout = tail.pinToTail
  const onLayout = useCallback(
    (event: { nativeEvent: { layout: { height: number } } }) => {
      viewHeight.current = event.nativeEvent.layout.height
      pinOnLayout()
      recheckEnd()
    },
    [pinOnLayout, recheckEnd]
  )
  const release = tail.releaseFollow
  /** A span measured in the window to the middle of the view, as the desktop centres a question. */
  const center = useCallback(
    (y: number, height: number, animated: boolean) => {
      release()
      scroll.current?.measureInWindow((_x, top, _width, view) => {
        const at = offset.current + y - top - (view - height) / 2
        scroll.current?.scrollTo({ y: Math.max(0, at), animated })
      })
    },
    [release]
  )
  return { tail, ref, onScroll, onContentSizeChange, onLayout, center }
}
