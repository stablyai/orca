import { useEffect, useLayoutEffect, useRef } from 'react'
import type { LayoutRectangle } from 'react-native'

/** Where a row sits in the queue's scroll content: rows stack in order, so it starts below those before it. */
export function queuedRowFrame(
  messageIds: readonly string[],
  heights: ReadonlyMap<string, number>,
  targetId: string | null
): LayoutRectangle | null {
  const index = targetId === null ? -1 : messageIds.indexOf(targetId)
  if (index === -1) {
    return null
  }
  let top = 0
  for (const [at, messageId] of messageIds.entries()) {
    const height = heights.get(messageId)
    // Not every row has laid out yet.
    if (height === undefined) {
      return null
    }
    if (at === index) {
      return { x: 0, y: top, width: 0, height }
    }
    top += height
  }
  return null
}

/** How long a requested row waits for its own fresh height before the list settles on the heights it has. */
export const QUEUED_ROW_SHOW_SETTLE_MS = 300

type ShowRow = (row: LayoutRectangle) => void

// Message ids cannot contain NUL.
const ID_SEPARATOR = '\u0000'
const NO_IDS: ReadonlySet<string> = new Set()

/**
 * Scrolls the queue to one row (a failure that opened the list) once that row has laid out again.
 * A row whose height never changes reports no layout, so the request settles shortly after either way.
 */
export function useQueuedRowShow(
  showId: string | null,
  setShowId: (messageId: null) => void,
  /** The queue's current order; a reorder moves rows by transform and lays none of them out. */
  messageIds: readonly string[]
) {
  const heights = useRef(new Map<string, number>())
  // Rows that reported since the current request, so an old height never places the row asked for.
  const fresh = useRef(new Set<string>())
  const lastShow = useRef<ShowRow | null>(null)
  // Whether the list was open when its rows last laid out; only shown rows lay out.
  const shownAll = useRef(false)
  const order = useRef(messageIds)
  useLayoutEffect(() => {
    order.current = messageIds
  })
  // Only queued rows keep a height, so a long conversation holds none for messages that left, and
  // an id that comes back (a requeued draft) waits for its own fresh layout.
  const liveKey = messageIds.join(ID_SEPARATOR)
  // Filled before any row lays out: layout effects run before native layout events.
  const live = useRef(NO_IDS)
  useLayoutEffect(() => {
    live.current = new Set(liveKey ? liveKey.split(ID_SEPARATOR) : [])
    for (const messageId of heights.current.keys()) {
      if (!live.current.has(messageId)) {
        heights.current.delete(messageId)
        fresh.current.delete(messageId)
      }
    }
  }, [liveKey])
  useLayoutEffect(() => {
    fresh.current.clear()
  }, [showId])
  useEffect(() => {
    if (showId === null) {
      return
    }
    const timer = setTimeout(() => {
      const frame = shownAll.current ? queuedRowFrame(order.current, heights.current, showId) : null
      setShowId(null)
      if (frame) {
        lastShow.current?.(frame)
      }
    }, QUEUED_ROW_SHOW_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [showId, setShowId])
  const measureRow = (
    list: { messageIds: readonly string[]; showAll: boolean },
    messageId: string,
    height: number,
    show: ShowRow
  ) => {
    // A row that already left can still report a layout queued before it went.
    if (!live.current.has(messageId)) {
      return
    }
    const { showAll } = list
    shownAll.current = showAll
    heights.current.set(messageId, height)
    fresh.current.add(messageId)
    lastShow.current = show
    if (showId === null || !showAll || !fresh.current.has(showId)) {
      return
    }
    const frame = queuedRowFrame(list.messageIds, heights.current, showId)
    if (frame) {
      setShowId(null)
      show(frame)
    }
  }
  return measureRow
}
