import { useCallback, useRef } from 'react'
import { Platform } from 'react-native'
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
  // Where a centring scroll is headed: until it lands there, its scroll events are Orca's, not the reader's.
  const centring = useRef<number | null>(null)
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
  const onEndDistance = tail.pageListProps.onEndDistance
  const report = useCallback(
    (metrics: MobileScrollTailMetrics, byReader: boolean) => {
      if (Platform.OS !== 'web') {
        record(metrics)
        return
      }
      // Web sends no drag events; Orca's own scrolls land at the end, so a scroll elsewhere is the reader's.
      const { contentOffset, contentSize, layoutMeasurement } = metrics
      onEndDistance(contentSize.height - (contentOffset.y + layoutMeasurement.height), byReader)
    },
    [record, onEndDistance]
  )
  const onScroll = useCallback(
    (event: { nativeEvent: MobileScrollTailMetrics }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
      offset.current = contentOffset.y
      viewHeight.current = layoutMeasurement.height
      contentHeight.current = contentSize.height
      const target = centring.current
      const landing =
        target !== null &&
        Math.abs(
          contentOffset.y - Math.min(target, contentSize.height - layoutMeasurement.height)
        ) <= 1
      if (landing) {
        centring.current = null
      }
      report(event.nativeEvent, target === null)
    },
    [report]
  )
  const pin = tail.pinToTailAfterContentResize
  const recheckEnd = useCallback(() => {
    if (viewHeight.current > 0 && contentHeight.current > 0) {
      report(
        {
          contentOffset: { y: offset.current },
          contentSize: { height: contentHeight.current },
          layoutMeasurement: { height: viewHeight.current }
        },
        false
      )
    }
  }, [report])
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
        const at = Math.max(0, offset.current + y - top - (view - height) / 2)
        const max = contentHeight.current - viewHeight.current
        // A scroll to where the view already is sends no event to clear the mark.
        centring.current = Math.abs(Math.min(at, max) - offset.current) > 1 ? at : null
        scroll.current?.scrollTo({ y: at, animated })
      })
    },
    [release]
  )
  return { tail, ref, onScroll, onContentSizeChange, onLayout, center }
}
