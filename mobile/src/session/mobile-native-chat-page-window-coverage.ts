/** The drawn rows `[start, end)` of `n`, the first drawn row's top in content coordinates, and the
 *  scroller's viewport. */
export type MobileNativeChatWindowGeometry = {
  n: number
  start: number
  end: number
  following: boolean
  windowTop: number
  scrollTop: number
  viewport: number
}

/** Rows within one screen of the viewport are drawn, rows past two are not; null when nothing
 *  changes. Rows above the window come only from the spacer, which holds measured heights, so drawing
 *  or dropping them never moves what the reader sees. `known` is a row's measured height. */
export function coverMobileNativeChatWindow(
  g: MobileNativeChatWindowGeometry,
  known: (index: number) => number | undefined,
  estimate: number
): { start: number; end: number } | null {
  const { n, following, scrollTop, viewport } = g
  const height = (at: number): number => known(at) ?? estimate
  const [near, far] = [scrollTop - viewport, scrollTop + 2 * viewport]
  let [start, end, top] = [g.start, g.end, g.windowTop]
  let bottom = top
  for (let at = start; at < end; at += 1) {
    bottom += height(at)
  }
  if (!following && (top > scrollTop + viewport || bottom < scrollTop)) {
    // Nothing drawn is on screen, so nothing needs to stay still: draw where the reader is.
    if (top > scrollTop) {
      while (start > 0 && known(start - 1) !== undefined && top > scrollTop) {
        start -= 1
        top -= known(start)!
      }
    } else {
      for (top = bottom, start = end; start < n - 1 && top + height(start) <= scrollTop;) {
        top += height(start)
        start += 1
      }
    }
    start = Math.min(start, n - 1)
    for (end = start, bottom = top; end < n && bottom < far; end += 1) {
      bottom += height(end)
    }
  } else {
    while (start > 0 && top > near && known(start - 1) !== undefined) {
      start -= 1
      top -= known(start)!
    }
    while (start < end - 1 && top + height(start) < scrollTop - 2 * viewport) {
      top += height(start)
      start += 1
    }
    while (end < n && bottom < far) {
      bottom += height(end)
      end += 1
    }
    while (!following && end - 1 > start && bottom - height(end - 1) > scrollTop + 3 * viewport) {
      end -= 1
      bottom -= height(end)
    }
  }
  end = following ? n : Math.max(end, start + 1)
  return start === g.start && end === g.end ? null : { start, end }
}
