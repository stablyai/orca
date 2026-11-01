import { useCallback, useEffect, useRef } from 'react'
import {
  mobileNativeChatRowViewportTops,
  type MobileNativeChatScrollNode
} from '../../mobile-native-chat-reading-place'
import {
  endAnchoredScrollTopForRow,
  previousMessageTarget,
  type PreviousMessageStop
} from './mobile-native-chat-previous-message'

const ALIGN_MS = 280
/** Missed measures after a row is drawn. A layout pass can run before the row node exists. */
const ALIGN_ATTEMPTS = 3

type LatestGeometry = {
  first: number
  keys: readonly string[]
  indexOf: ReadonlyMap<string, number>
  n: number
  rowKeys: { scope: string }
}

type AlignArgs<S extends MobileNativeChatScrollNode> = {
  scroller: () => S | null
  write: (s: S, to: number) => void
  notePlace: (s: S) => void
  latest: { current: LatestGeometry }
  revealUndrawn: (index: number) => void
}

export type MobileNativeChatPreviousAlign<S extends MobileNativeChatScrollNode> = {
  aligning: { current: boolean }
  hasPreviousMessage: (keys: readonly string[]) => boolean
  revealPreviousMessage: (keys: readonly string[], animated: boolean) => void
  finishPendingAlign: (s: S) => void
}

function stopsOf(s: MobileNativeChatScrollNode, keys: readonly string[]): PreviousMessageStop[] {
  const tops = mobileNativeChatRowViewportTops(s, keys)
  return keys.map((key) => {
    const top = tops.get(key)
    return top === undefined ? { key } : { key, top }
  })
}

/** Smooth-scroll an end-anchored page so a message top meets the viewport, including rows not drawn yet. */
export function useMobileNativeChatPreviousAlign<S extends MobileNativeChatScrollNode>(
  args: AlignArgs<S>
): MobileNativeChatPreviousAlign<S> {
  const argsRef = useRef(args)
  argsRef.current = args
  const aligning = useRef(false)
  const alignFrame = useRef(0)
  const pendingAlign = useRef<{ key: string; animated: boolean; left: number } | null>(null)

  const alignRow = useCallback((s: S, key: string, animated: boolean): boolean => {
    const { write, notePlace, scroller } = argsRef.current
    // Tops are already viewport-relative, so the view origin is 0.
    const top = mobileNativeChatRowViewportTops(s, [key]).get(key)
    if (top === undefined) {
      return false
    }
    const to = endAnchoredScrollTopForRow(s.scrollTop, top, 0)
    cancelAnimationFrame(alignFrame.current)
    alignFrame.current = 0
    if (!animated || Math.abs(to - s.scrollTop) < 0.5) {
      aligning.current = false
      write(s, to)
      notePlace(s)
      return true
    }
    aligning.current = true
    const from = s.scrollTop
    const started = performance.now()
    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / ALIGN_MS)
      const eased = 1 - (1 - t) ** 3
      write(s, from + (to - from) * eased)
      if (t < 1) {
        alignFrame.current = requestAnimationFrame(step)
        return
      }
      aligning.current = false
      alignFrame.current = 0
      const current = scroller()
      if (current) {
        notePlace(current)
      }
    }
    alignFrame.current = requestAnimationFrame(step)
    return true
  }, [])

  useEffect(
    () => () => {
      if (alignFrame.current !== 0) {
        cancelAnimationFrame(alignFrame.current)
      }
    },
    []
  )

  const hasPreviousMessage = useCallback((stopKeys: readonly string[]) => {
    const s = argsRef.current.scroller()
    return s ? previousMessageTarget(stopsOf(s, stopKeys)) !== null : false
  }, [])

  const revealPreviousMessage = useCallback(
    (stopKeys: readonly string[], animated: boolean) => {
      const { scroller, latest, revealUndrawn } = argsRef.current
      const s = scroller()
      if (!s) {
        return
      }
      const target = previousMessageTarget(stopsOf(s, stopKeys))
      if (!target) {
        return
      }
      if ('key' in target) {
        pendingAlign.current = null
        alignRow(s, target.key, animated)
        return
      }
      const index = latest.current.indexOf.get(target.pendingKey)
      if (index === undefined) {
        return
      }
      pendingAlign.current = { key: target.pendingKey, animated, left: ALIGN_ATTEMPTS }
      if (index < latest.current.first) {
        revealUndrawn(index)
        return
      }
      if (alignRow(s, target.pendingKey, animated)) {
        pendingAlign.current = null
      }
    },
    [alignRow]
  )

  const finishPendingAlign = useCallback(
    (s: S) => {
      const pending = pendingAlign.current
      if (!pending || aligning.current) {
        return
      }
      if (alignRow(s, pending.key, pending.animated)) {
        pendingAlign.current = null
        return
      }
      const { latest } = argsRef.current
      const at = latest.current.indexOf.get(pending.key)
      // Still outside the draw window: wait for reveal instead of spending a retry.
      if (at === undefined || at < latest.current.first) {
        return
      }
      pending.left -= 1
      if (pending.left <= 0) {
        pendingAlign.current = null
      }
    },
    [alignRow]
  )

  return { aligning, hasPreviousMessage, revealPreviousMessage, finishPendingAlign }
}
