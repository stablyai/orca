import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MobileNativeChatPageHeights } from './mobile-native-chat-page-heights'
import { MobileNativeChatPageAnchoring } from './mobile-native-chat-page-anchoring'
import {
  MobileNativeChatPageMotion,
  pageKeepsPlace,
  scrollWritesStopMomentum
} from './mobile-native-chat-page-motion'
import { MobileNativeChatPageRows } from './mobile-native-chat-page-rows'
import { coverMobileNativeChatWindow } from './mobile-native-chat-page-window-coverage'
import type {
  MobileNativeChatWindowDrawn as Drawn,
  MobileNativeChatWindowGroup as Group,
  MobileNativeChatPageWindowArgs,
  MobileNativeChatWindowScroller,
  MobileNativeChatWindowSeat as Win
} from './mobile-native-chat-page-window-state'
import { useMobileNativeChatPageRender } from './use-mobile-native-chat-page-render'

/** Rows measured in one settled moment: few enough not to drop a frame. */
const MEASURE_ROWS = 8
/** Between measuring rounds, so a streamed reply still gets frames while rows are measured. */
const MEASURE_GAP_MS = 32
/** A parked reader's unmeasured rows are measured only within this many screens above them. */
const MEASURE_REACH = 3
/** While following, every measured row is checked for a change at most this often. */
const STALE_SCAN_MS = 1_000
/** While following, measuring waits until a streaming reply pauses this long, so its updates keep
 *  the frames. */
const STREAM_PAUSE_MS = 300

/** The page's rows near the screen, keyed. Above the window the spacer stands only for measured rows:
 *  rows never measured are left out, and are measured in place only while nothing can move the
 *  reader (following, or settled), because iOS stops momentum on any scroll write. */
export function useMobileNativeChatPageWindow(args: MobileNativeChatPageWindowArgs) {
  const { rows, rowKeys, rowState, following, isFollowing, layoutKey, scroller, roots } = args
  const render = useMobileNativeChatPageRender()
  const [heights] = useState(() => new MobileNativeChatPageHeights())
  const w = useRef<Win | null>(null)
  const drawn = useRef<Drawn | null>(null)
  const settle = useRef(false)
  const [drawnRows] = useState(() => new MobileNativeChatPageRows())
  const anchorStale = useRef(false)
  const width = useRef(0)
  const viewport = useRef(globalThis.innerHeight || 800)
  const lastScan = useRef(0)
  const streamedAt = useRef(0)
  const onSettled = useRef(() => {})
  const [motion] = useState(() => new MobileNativeChatPageMotion(() => onSettled.current()))
  const [anchoring] = useState(() => new MobileNativeChatPageAnchoring(scroller, isFollowing))
  const { keys, changed, indexOf } = useMemo(
    () => heights.sourceKeys(rows, rowKeys.keyOf, drawn.current?.keys),
    [rows, rowKeys.keyOf, heights]
  )
  const n = keys.length
  const at = (key: string, fallback: number): number =>
    keys[fallback] === key
      ? fallback
      : (indexOf(rowKeys.current(key)) ?? Math.max(0, Math.min(fallback, n - 1)))
  const seatAtEnd = (): Win => {
    let first = n
    for (let filled = 0; first > 0 && filled < viewport.current; first -= 1) {
      filled += heights.px(keys[first - 1]) ?? heights.estimate()
    }
    const seat = { first: keys[first] ?? '', firstAt: first, last: null, lastAt: n - 1 }
    return { scope: rowKeys.scope, ...seat, slack: 0, measure: null }
  }

  const kept = w.current?.scope === rowKeys.scope && w.current.first !== '' ? w.current : null
  let win = kept ?? seatAtEnd()
  let end = win.last === null ? n : at(win.last, win.lastAt) + 1
  if (following && win.last !== null) {
    win = end >= n ? { ...win, last: null } : seatAtEnd()
    end = n
  }
  const start = Math.min(at(win.first, win.firstAt), Math.max(0, end - 1))
  end = Math.min(n, Math.max(end, start + 1))

  const d = drawn.current
  const sourceChanged = d !== null && d.sourceHead !== rowKeys.sourceHead
  let slack = following || !kept || settle.current ? 0 : win.slack
  if (d && sourceChanged && !following && kept && d.keys !== keys) {
    // A cap trim takes rows from the top; what was drawn of them stays as space until settled.
    for (let i = d.first; i < d.end && indexOf(rowKeys.current(d.keys[i]!)) === undefined; i += 1) {
      slack += heights.px(d.keys[i]) ?? 0
    }
  }
  // A source change keeps no measuring rows: the place-hold owns that commit's correction.
  let [m0, m1] = [start, start]
  const group = sourceChanged || !win.measure ? null : win.measure
  if (group) {
    const [from, to] = [at(group.from, group.fromAt), at(group.to, group.toAt) + 1]
    if (from < to && to <= start) {
      ;[m0, m1] = [from, to]
    }
  }
  const { first, above, mid, bottom } = heights.spacers(keys, [m0, m1], [start, end], slack)
  const measuring = n > 0 && Math.min(m0, start) > 0 && heights.px(keys[0]) === undefined

  const write = useCallback(
    (s: MobileNativeChatWindowScroller, to: number) => {
      const max = s.scrollHeight - s.clientHeight
      const target = Math.max(0, Math.min(to, max))
      // Above the top only while iOS bounces there. Past the end may be a clamp the browser hasn't
      // applied yet; every write here waits for rest, so it isn't a bounce.
      if (s.scrollTop >= 0 && Math.abs(target - s.scrollTop) >= 0.5) {
        motion.wrote(target)
        s.scrollTop = target
      }
    },
    [motion]
  )

  const takeAnchor = useCallback(
    (s: MobileNativeChatWindowScroller) => {
      // Elsewhere the browser's anchoring keeps a parked place and the end pin a following one.
      if (!pageKeepsPlace(s.scrollTop)) {
        drawnRows.forgetAnchor()
        return
      }
      const at = drawn.current
      // A following reader is held by the end pin: the row's own top is enough there.
      drawnRows.takeAnchor(s, at?.keys ?? [], [at?.start ?? 0, at?.end ?? 0], !at?.following)
    },
    [drawnRows]
  )

  const cover = useCallback(
    (s: MobileNativeChatWindowScroller) => {
      const [at, cur] = [drawn.current, w.current]
      const firstNode = at && drawnRows.node(at.keys[at.start])
      // Before the observer reports every drawn row, a guess would move the window off the reader.
      const unmeasured =
        at && at.keys.slice(at.start, at.end).some((key) => heights.px(key) === undefined)
      if (!at || !cur || !firstNode || unmeasured) {
        return
      }
      const next = coverMobileNativeChatWindow(
        {
          n: at.keys.length,
          start: at.start,
          end: at.end,
          // Drawn to the end only while it is near: a jump away is drawn where it lands, not to the end.
          following: at.following && s.scrollTop >= s.scrollHeight - 2 * s.clientHeight,
          windowTop:
            firstNode.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop,
          scrollTop: s.scrollTop,
          viewport: s.clientHeight
        },
        (i) => heights.px(at.keys[i]),
        heights.estimate()
      )
      if (next) {
        const last = next.end >= at.keys.length ? null : at.keys[next.end - 1]!
        const measure = next.start === at.start ? cur.measure : null
        const moved = { first: at.keys[next.start]!, firstAt: next.start, last }
        w.current = { ...cur, ...moved, lastAt: next.end - 1, measure }
        render()
      }
    },
    [heights, render, drawnRows]
  )

  // Owed work that can move rows above the reader, done only while settled: measure the nearest rows
  // that are unmeasured or may have changed, and give back trimmed space.
  const measureOwed = useCallback(() => {
    const [at, cur] = [drawn.current, w.current]
    if (!at || !cur || at.keys.length === 0) {
      return
    }
    const layout = `${at.layoutKey}:${width.current}`
    // A drawn group is measured before paint; choosing again first would take it down unmeasured.
    if (cur.measure && heights.px(cur.measure.to) === undefined) {
      return
    }
    const streaming = STREAM_PAUSE_MS - (Date.now() - streamedAt.current)
    if (at.following && streaming > 0) {
      motion.pokeIn(streaming)
      return
    }
    const since = Date.now() - lastScan.current
    const full = at.following && at.first === 0 && since >= STALE_SCAN_MS
    const run = heights.next(at, layout, MEASURE_REACH * viewport.current, MEASURE_ROWS, full)
    if (full) {
      lastScan.current = Date.now()
    } else if (!run && at.following && at.first === 0) {
      motion.pokeIn(STALE_SCAN_MS - since)
    }
    const measure: Group | null = run && {
      from: at.keys[run[0]]!,
      fromAt: run[0],
      to: at.keys[run[1]]!,
      toAt: run[1]
    }
    if (measure?.from !== cur.measure?.from || measure?.to !== cur.measure?.to || cur.slack > 0) {
      w.current = { ...cur, measure }
      settle.current = true
      motion.quiet(MEASURE_GAP_MS)
      render()
    }
  }, [heights, motion, render])

  useLayoutEffect(() => {
    onSettled.current = measureOwed
    if (w.current && w.current.scope !== rowKeys.scope) {
      heights.clear()
      motion.release()
      drawnRows.forgetAnchor()
    }
    if (changed && drawn.current?.keys !== keys) {
      heights.retain(keys)
    }
    const last = end >= n ? null : keys[end - 1]!
    const m = m0 < m1 ? { from: keys[m0]!, fromAt: m0, to: keys[m1 - 1]!, toAt: m1 - 1 } : null
    const seat = { first: keys[start] ?? '', firstAt: start, last, lastAt: end - 1 }
    w.current = { ...win, ...seat, slack, measure: m }
    if (drawn.current && drawn.current.rows !== rows && following) {
      streamedAt.current = Date.now()
    }
    const fresh = { keys, rows, indexOf, rowState, start, end, first, following, layoutKey }
    drawn.current = { ...fresh, sourceHead: rowKeys.sourceHead }
    settle.current = false
    anchoring.committed()
    const s = scroller()
    if (s && anchorStale.current) {
      anchorStale.current = false
      takeAnchor(s)
    }
    motion.laidOut([n, m0, m1, start, end, above, mid, bottom, layoutKey].join(':'))
    if (n > 0) {
      motion.poke()
    }
  })

  useLayoutEffect(() => {
    const s = scroller()
    if (!s) {
      return
    }
    const scrolled = () => {
      // A write's or layout's event can arrive after rows above changed and before the correction:
      // taking the place or covering then would keep the moved position and draw what moved it.
      const max = s.scrollHeight - s.clientHeight
      const { by } = motion.scrolled(s.scrollTop, max, () => drawnRows.placeMoved(s))
      if (by === 'reader') {
        takeAnchor(s)
      }
      // Where the browser keeps the place, the page writes no correction to wait for.
      if (by === 'reader' || (by === 'layout' && !scrollWritesStopMomentum())) {
        cover(s)
      }
    }
    const detach = motion.attach(s)
    s.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      detach()
      s.removeEventListener('scroll', scrolled)
      motion.release()
    }
  }, [scroller, motion, takeAnchor, cover, drawnRows, anchoring, roots])

  /** The one observer's entries: rows measured, then, for a parked reader (on WebKit at rest),
   *  whatever moved the row they were reading goes back (a measured row, the header, given-back
   *  space). */
  const afterResize = useCallback(
    (entries: readonly ResizeObserverEntry[], pin: () => void) => {
      const [s, at] = [scroller(), drawn.current]
      if (!s || !at) {
        return pin()
      }
      viewport.current = s.clientHeight
      width.current = s.clientWidth
      const layout = `${at.layoutKey}:${width.current}`
      for (const entry of entries) {
        const key = drawnRows.keyOf(entry.target)
        const i = at.indexOf(key)
        if (key !== undefined && i !== undefined) {
          const row = at.rows[i]!
          heights.remember(key, entry.contentRect.height, row, at.rowState(i, row), layout)
        }
      }
      // As of the layout, before a move no scroll event has reported yet is counted.
      roots?.restoreAll()
      const own = !at.following && motion.mayCorrect() && pageKeepsPlace(s.scrollTop)
      const shift = own ? drawnRows.placeShift(s) : null
      const max = s.scrollHeight - s.clientHeight
      const { by, moved } = motion.reconciled(s.scrollTop, max)
      if (shift !== null) {
        // Rows above moved by `shift`: put that back, keep the reader's own move, undo a clamp.
        write(s, s.scrollTop - (by === 'layout' ? moved : 0) + shift)
      }
      // After the reader's unreported move is counted (it may end following), so the pin can't undo it.
      pin()
      // The place is where the reader is now: a correction that couldn't land, or a move while
      // they scrolled, is not owed later.
      takeAnchor(s)
      cover(s)
      motion.poke()
    },
    [scroller, heights, motion, write, cover, drawnRows, takeAnchor, roots]
  )

  /** The place-hold's correction, when one may be written: on WebKit only at rest (mid-motion the
   *  reader already saw the move, and putting it back at rest would be a second jump), except a
   *  regroup, which resizes drawn rows at once and nothing redoes later. */
  const keepInPlace = useCallback(
    (drift: number, regrouped: boolean) => {
      const s = scroller()
      if (s && !drawn.current?.following && (regrouped || motion.mayCorrect())) {
        write(s, s.scrollTop + drift)
        anchorStale.current = true
      }
    },
    [scroller, motion, write]
  )

  // Stable, so the list's handle (and with it the one observer) is made once.
  const list = useMemo(
    () => ({
      afterResize,
      keepInPlace,
      observeWith: (observer: ResizeObserver | null) => {
        drawnRows.observeWith(observer)
        roots?.observeWith(observer)
      },
      settled: () => roots?.settled(motion) ?? motion.whenSettled(),
      syncAnchoring: () => anchoring.sync(),
      holdPlace: (on: boolean) => anchoring.hold(on),
      watchMotion: (fn: typeof motion.onMotion) => {
        motion.onMotion = fn
      },
      wrote: (target: number) => motion.wrote(target)
    }),
    [afterResize, keepInPlace, drawnRows, motion, anchoring, roots]
  )

  return {
    view: { m0, m1, start, end, above, mid, bottom, measuring },
    rowRef: drawnRows.ref,
    list
  }
}
