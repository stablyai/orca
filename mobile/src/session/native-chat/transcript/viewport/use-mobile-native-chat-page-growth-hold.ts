import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, RefObject } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatRowKeys } from '../projection/mobile-native-chat-row-keys'
import { createMobileNativeChatGrowthHold } from './mobile-native-chat-growth-hold'
import type { MobileNativeChatPageScroller } from './mobile-native-chat-reading-place'

// Wait for scroll and touch rest before corrections so iOS momentum is not interrupted.
const REST_MS = 300

type Held = {
  rows: readonly NativeChatMessage[]
  footer: ReactElement | null
  // Freeze renderItem too: grouping/turn context changes a row even if its message is unchanged.
  renderItem: (row: { item: NativeChatMessage; index: number }) => ReactElement
}

function mobileNativeChatHeldRows(
  held: Held | null,
  liveRows: readonly NativeChatMessage[],
  rowKeys: Pick<MobileNativeChatRowKeys, 'keyOf'>,
  runs: ReadonlyMap<number, readonly NativeChatMessage[]> | undefined
) {
  const unheld = { rows: liveRows, heldFrom: Infinity, heldAt: 0 }
  const head = held?.rows[0]
  const at = head ? liveRows.findIndex((row) => rowKeys.keyOf(row) === rowKeys.keyOf(head)) : -1
  if (!held || at === -1) {
    return unheld
  }
  // A newly prepended run head owns its held members; draw those members live.
  let last: NativeChatMessage | undefined
  for (const [index, members] of runs ?? []) {
    if (index >= at) {
      break
    }
    last = members.at(-1)
  }
  const from = Math.max(at, last ? liveRows.indexOf(last, at) + 1 : 0)
  const kept = liveRows.slice(at, from).every((row, i) => {
    const was = held.rows[i]
    return was !== undefined && rowKeys.keyOf(was) === rowKeys.keyOf(row)
  })
  return kept
    ? {
        rows: [...liveRows.slice(0, from), ...held.rows.slice(from - at)],
        heldFrom: from,
        heldAt: at
      }
    : unheld
}

// Freeze below-reader growth during a fling because corrective writes stop iOS momentum.
export function useMobileNativeChatPageGrowthHold({
  liveRows,
  liveFooter,
  renderItem,
  runs,
  rowKeys,
  scroller,
  isFollowing,
  readerScrolledAt
}: {
  liveRows: Held['rows']
  liveFooter: Held['footer']
  renderItem: Held['renderItem']
  runs: ReadonlyMap<number, readonly NativeChatMessage[]> | undefined
  rowKeys: Pick<MobileNativeChatRowKeys, 'keyOf'>
  scroller: () => MobileNativeChatPageScroller | null
  isFollowing: () => boolean
  readerScrolledAt: RefObject<number>
}) {
  const heldRef = useRef<Held | null>(null)
  const [, release] = useState(0)
  const held = heldRef.current
  const rows = useMemo(
    () => mobileNativeChatHeldRows(held, liveRows, rowKeys, runs),
    [held, liveRows, rowKeys, runs]
  )
  const live = useRef<Held>({ rows: liveRows, footer: liveFooter, renderItem })
  const touching = useRef(false)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const settle = useRef(() => {})
  const [growth] = useState(createMobileNativeChatGrowthHold)
  const resting = useCallback(
    () => !touching.current && Date.now() - readerScrolledAt.current >= REST_MS,
    [readerScrolledAt]
  )
  const unhold = useCallback(() => {
    if (heldRef.current) {
      heldRef.current = null
      growth.set(false)
      release((n) => n + 1)
    }
  }, [growth])
  const hold = useCallback(() => {
    if (!isFollowing()) {
      heldRef.current ??= live.current
      growth.set(true)
      clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(() => settle.current(), REST_MS)
    }
  }, [growth, isFollowing])
  useLayoutEffect(() => {
    live.current = { rows: liveRows, footer: liveFooter, renderItem }
    settle.current = () => {
      if (resting() || isFollowing()) {
        unhold()
      } else {
        settleTimer.current = setTimeout(() => settle.current(), REST_MS)
      }
    }
  })
  // A hidden chat keeps its hold but loses its timer; settle it again when the chat shows.
  useEffect(() => {
    if (heldRef.current) {
      settle.current()
    }
    return () => {
      clearTimeout(settleTimer.current)
      touching.current = false
    }
  }, [])
  useEffect(() => {
    const s = scroller()
    if (!s) {
      return
    }
    const down = () => {
      touching.current = true
      hold()
    }
    const up = () => {
      touching.current = false
    }
    const options = { capture: true, passive: true }
    // Listen to both touch and pointer events because either can arrive first or be missing.
    const downs = ['touchstart', 'pointerdown']
    const ups = ['touchend', 'touchcancel', 'pointerup', 'pointercancel']
    downs.forEach((type) => s.addEventListener(type, down, options))
    ups.forEach((type) => s.addEventListener(type, up, options))
    return () => {
      downs.forEach((type) => s.removeEventListener(type, down, options))
      ups.forEach((type) => s.removeEventListener(type, up, options))
    }
  }, [scroller, hold])
  return { ...rows, held, growth, resting, hold, unhold }
}
