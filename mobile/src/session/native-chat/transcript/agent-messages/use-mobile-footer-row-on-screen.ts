import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { Platform, type LayoutChangeEvent } from 'react-native'
import type { MobileNativeChatTailViewport } from '../viewport/mobile-native-chat-tail-viewport'

/** The height of the block of rows drawn last in the list, so each can tell how far it sits above
 *  the content's end. */
export type MobileFooterBlock = {
  onLayout: (event: LayoutChangeEvent) => void
  height: () => number | null
  subscribe: (listener: () => void) => () => void
}

export function createMobileFooterBlock(): MobileFooterBlock {
  let height: number | null = null
  const listeners = new Set<() => void>()
  return {
    onLayout: (event) => {
      height = event.nativeEvent.layout.height
      listeners.forEach((notify) => notify())
    },
    height: () => height,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

const NO_STOP = (): void => {}

/** The scroller the rows sit at the end of, where it is not the chat's list (under bot setup). */
export const MobileFooterRowsScrollerContext = createContext<MobileNativeChatTailViewport | null>(
  null
)

// The list's own bottom padding and a row's ring sit within this of the measured edges.
const SLACK_PX = 48

let sharedObserver: IntersectionObserver | null = null
const onScreenListeners = new Map<Element, (onScreen: boolean) => void>()

function observeOnScreen(element: Element, listener: (onScreen: boolean) => void): () => void {
  sharedObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        onScreenListeners.get(entry.target)?.(entry.isIntersecting)
      }
    },
    { rootMargin: `${SLACK_PX}px` }
  )
  onScreenListeners.set(element, listener)
  sharedObserver.observe(element)
  return () => {
    onScreenListeners.delete(element)
    sharedObserver?.unobserve(element)
  }
}

/** Whether a row drawn last in the list is on screen. The page reads it from the browser; the native
 *  list from the row's place in the block and the list's scroll. Unknown counts as on screen. */
export function useMobileFooterRowOnScreen(
  listViewport: MobileNativeChatTailViewport | undefined,
  block: MobileFooterBlock
): {
  onScreen: boolean
  ref: (node: unknown) => void
  onLayout?: (event: LayoutChangeEvent) => void
} {
  const web = Platform.OS === 'web'
  const viewport = useContext(MobileFooterRowsScrollerContext) ?? listViewport
  const [element, setElement] = useState<Element | null>(null)
  const [webOnScreen, setWebOnScreen] = useState(true)
  const ref = useCallback(
    (node: unknown) => setElement(web && node instanceof Element ? node : null),
    [web]
  )
  useEffect(() => {
    if (!element || typeof IntersectionObserver !== 'function') {
      return undefined
    }
    return observeOnScreen(element, setWebOnScreen)
  }, [element])

  const bounds = useRef<{ y: number; height: number } | null>(null)
  const [, setLaidOut] = useState(0)
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout
    bounds.current = { y, height }
    setLaidOut((count) => count + 1)
  }, [])
  // The page answers from the browser alone; its rows never listen to the list's scroll.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (web) {
        return NO_STOP
      }
      const stopViewport = viewport?.subscribe(listener)
      const stopBlock = block.subscribe(listener)
      return () => {
        stopViewport?.()
        stopBlock()
      }
    },
    [web, viewport, block]
  )
  const read = (): boolean => {
    const view = viewport?.read()
    const total = block.height()
    const row = bounds.current
    if (web || !view || total === null || !row) {
      return true
    }
    const bottomFromEnd = total - (row.y + row.height)
    const topFromEnd = total - row.y
    return (
      bottomFromEnd <= view.fromEnd + view.height + SLACK_PX &&
      topFromEnd >= view.fromEnd - SLACK_PX
    )
  }
  const nativeOnScreen = useSyncExternalStore(subscribe, read, read)
  return web ? { onScreen: webOnScreen, ref } : { onScreen: nativeOnScreen, ref, onLayout }
}
