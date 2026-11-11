import type { Dispatch, SetStateAction } from 'react'
import type { MobileDisplayMode } from './mobile-terminal-model'

/** Records a stream event's layout seq; false for a superseded `resized`. Each `subscribed` resets the mark;
 * scrollback leaves it, because binary scrollback `seq` counts output bytes, not layout changes. */
export function acceptTerminalLayoutSeq(
  marks: Map<string, number>,
  handle: string,
  data: Readonly<Record<string, unknown>>
): boolean {
  const eventSeq = typeof data.seq === 'number' ? data.seq : null
  if (eventSeq != null && data.type === 'resized') {
    const last = marks.get(handle)
    if (last != null && eventSeq < last && last - eventSeq <= 20) {
      console.log('[fit][session] DROP-stale-seq', {
        handle: handle.slice(-8),
        type: data.type,
        eventSeq,
        lastSeq: last,
        cols: data.cols,
        rows: data.rows,
        displayMode: data.displayMode
      })
      return false
    }
    marks.set(handle, eventSeq)
  } else if (data.type === 'subscribed' && eventSeq != null) {
    marks.set(handle, eventSeq)
  } else if (data.type === 'subscribed') {
    marks.delete(handle)
  }
  return true
}

/** Adopts a stream event's display mode for `handle`. */
export function terminalDisplayModeAdopter(
  setTerminalModes: Dispatch<SetStateAction<Map<string, MobileDisplayMode>>>,
  handle: string
): (displayMode: unknown) => void {
  return (displayMode) => {
    if (displayMode !== 'auto' && displayMode !== 'phone' && displayMode !== 'desktop') {
      return
    }
    // Reuse mode Map on no-op frames so every stream pass cannot rerender the route.
    setTerminalModes((prev) =>
      prev.get(handle) === displayMode ? prev : new Map(prev).set(handle, displayMode)
    )
  }
}
