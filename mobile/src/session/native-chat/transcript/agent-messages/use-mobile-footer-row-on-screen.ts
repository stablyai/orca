import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore
} from 'react'
import { Platform, type LayoutChangeEvent } from 'react-native'
import type { MobileNativeChatTailViewport } from '../viewport/mobile-native-chat-tail-viewport'

/** The rows drawn last in a list, which the list does not window: this owner does, from their
 *  measured places and the list's view of its end. A scroll step costs one search over the rows and
 *  wakes only the rows that come into or leave view. */
export type MobileFooterBlock = {
  onLayout: (event: LayoutChangeEvent) => void
  rowLaidOut: (id: string, y: number, height: number) => void
  rowGone: (id: string) => void
  onScreen: (id: string) => boolean
  subscribeRow: (id: string, listener: () => void) => () => void
  /** Follows `viewport` until the returned stop; none counts every row as on screen. */
  watch: (viewport: MobileNativeChatTailViewport | undefined) => () => void
}

// The list's own bottom padding sits within this of the measured edges, and rows just past the
// view are drawn before they scroll in.
const SLACK_PX = 96

type Bounds = { id: string; y: number; height: number }

export function createMobileFooterBlock(): MobileFooterBlock {
  let total: number | null = null
  let viewport: MobileNativeChatTailViewport | undefined
  const bounds = new Map<string, Bounds>()
  let sorted: Bounds[] | null = null
  // Null: everything counts as on screen (nothing measured, or no view to measure against).
  let shown: Set<string> | null = null
  const listeners = new Map<string, Set<() => void>>()

  const visible = (): Set<string> | null => {
    const view = viewport?.read()
    if (!view || total === null || bounds.size === 0) {
      return null
    }
    sorted ??= [...bounds.values()].sort((a, b) => a.y - b.y)
    // The part of the block in view, in the block's own top-down coordinates.
    const low = total - (view.fromEnd + view.height + SLACK_PX)
    const high = total - (view.fromEnd - SLACK_PX)
    let first = 0
    let last = sorted.length
    while (first < last) {
      const mid = (first + last) >> 1
      if (sorted[mid]!.y + sorted[mid]!.height <= low) {
        first = mid + 1
      } else {
        last = mid
      }
    }
    const next = new Set<string>()
    for (let at = first; at < sorted.length && sorted[at]!.y < high; at++) {
      next.add(sorted[at]!.id)
    }
    return next
  }
  const notify = (id: string): void => listeners.get(id)?.forEach((listener) => listener())
  const update = (): void => {
    const next = visible()
    const before = shown
    shown = next
    if (before === null && next === null) {
      return
    }
    if (before === null || next === null) {
      listeners.forEach((_, id) => notify(id))
      return
    }
    before.forEach((id) => !next.has(id) && notify(id))
    next.forEach((id) => !before.has(id) && notify(id))
  }
  let stopViewport: (() => void) | undefined
  // A reflow moves every row below it, each reporting its own layout: rebuild once per frame.
  let frame: number | null = null
  const updateSoon = (): void => {
    frame ??= requestAnimationFrame(() => {
      frame = null
      update()
    })
  }
  return {
    onLayout: (event) => {
      total = event.nativeEvent.layout.height
      updateSoon()
    },
    rowLaidOut: (id, y, height) => {
      const before = bounds.get(id)
      if (before && before.y === y && before.height === height) {
        return
      }
      bounds.set(id, { id, y, height })
      sorted = null
      updateSoon()
    },
    rowGone: (id) => {
      bounds.delete(id)
      sorted = null
    },
    onScreen: (id) => shown === null || shown.has(id),
    subscribeRow: (id, listener) => {
      const own = listeners.get(id) ?? new Set()
      own.add(listener)
      listeners.set(id, own)
      return () => {
        own.delete(listener)
        if (own.size === 0) {
          listeners.delete(id)
        }
      }
    },
    watch: (next) => {
      viewport = next
      stopViewport?.()
      stopViewport = next?.subscribe(update)
      update()
      return () => {
        stopViewport?.()
        stopViewport = undefined
        viewport = undefined
        if (frame !== null) {
          cancelAnimationFrame(frame)
          frame = null
        }
      }
    }
  }
}

/** The scroller the rows sit at the end of, where it is not the chat's list (under bot setup). */
export const MobileFooterRowsScrollerContext = createContext<MobileNativeChatTailViewport | null>(
  null
)

/** The block follows the list it ends, or the setup scroller standing in for it. */
export function useMobileFooterBlock(listViewport: MobileNativeChatTailViewport | undefined) {
  const [block] = useState(createMobileFooterBlock)
  const viewport = useContext(MobileFooterRowsScrollerContext) ?? listViewport
  const web = Platform.OS === 'web'
  useEffect(() => {
    if (web) {
      return undefined
    }
    const stop = block.watch(viewport)
    return () => stop()
  }, [block, viewport, web])
  return block
}

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

const NO_STOP = (): void => {}

/** Whether one row of the block is in view: the page reads it from the browser, the native list
 *  from the block. Unknown counts as on screen. */
export function useMobileFooterRowOnScreen(
  block: MobileFooterBlock,
  id: string
): {
  onScreen: boolean
  ref: (node: unknown) => void
  onLayout: (event: LayoutChangeEvent) => void
} {
  const web = Platform.OS === 'web'
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
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout
      block.rowLaidOut(id, y, height)
    },
    [block, id]
  )
  useEffect(() => () => block.rowGone(id), [block, id])
  const subscribe = useCallback(
    (listener: () => void) => (web ? NO_STOP : block.subscribeRow(id, listener)),
    [block, id, web]
  )
  const read = (): boolean => web || block.onScreen(id)
  const nativeOnScreen = useSyncExternalStore(subscribe, read, read)
  return { onScreen: web ? webOnScreen : nativeOnScreen, ref, onLayout }
}
