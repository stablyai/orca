import { useCallback, useEffect, useRef } from 'react'
import {
  mobileNativeChatRowViewportTops,
  type MobileNativeChatScrollNode
} from '../../mobile-native-chat-reading-place'
import {
  endAnchoredScrollTopForRow,
  previousMessageChained,
  previousMessageTarget,
  type PreviousMessageStop,
  type PreviousMessageTarget
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
  cancelAlign: () => void
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
  const jumpGen = useRef(0)
  // The row this jump is bringing to the top. A second tap steps from it, not the in-between offset.
  const inflightKey = useRef<string | null>(null)
  const pendingAlign = useRef<{ key: string; animated: boolean; left: number } | null>(null)

  const haltFrame = useCallback(() => {
    jumpGen.current += 1
    if (alignFrame.current !== 0) {
      cancelAnimationFrame(alignFrame.current)
      alignFrame.current = 0
    }
  }, [])

  // An equal write does not cancel a fling. Nudge within the scroll range, then put it back.
  const settleScroll = useCallback((s: S) => {
    aligning.current = true
    const top = s.scrollTop
    s.scrollTop = top >= 0 ? top - 1 : top + 1
    s.scrollTop = top
  }, [])

  const alignRow = useCallback((s: S, key: string, animated: boolean): boolean => {
    const { write, notePlace, scroller } = argsRef.current
    // Tops are already viewport-relative, so the view origin is 0.
    const top = mobileNativeChatRowViewportTops(s, [key]).get(key)
    if (top === undefined) {
      return false
    }
    const to = endAnchoredScrollTopForRow(s.scrollTop, top, 0)
    const gen = ++jumpGen.current
    if (alignFrame.current !== 0) {
      cancelAnimationFrame(alignFrame.current)
      alignFrame.current = 0
    }
    inflightKey.current = key
    if (!animated || Math.abs(to - s.scrollTop) < 0.5) {
      aligning.current = false
      write(s, to)
      if (inflightKey.current === key) {
        inflightKey.current = null
      }
      notePlace(s)
      return true
    }
    aligning.current = true
    const from = s.scrollTop
    const started = performance.now()
    const step = (now: number): void => {
      // A queued frame from the jump this tap replaced must not write or clear the new one.
      if (jumpGen.current !== gen) {
        return
      }
      if (!aligning.current) {
        alignFrame.current = 0
        return
      }
      const t = Math.min(1, (now - started) / ALIGN_MS)
      const eased = 1 - (1 - t) ** 3
      write(s, from + (to - from) * eased)
      if (t < 1) {
        alignFrame.current = requestAnimationFrame(step)
        return
      }
      aligning.current = false
      alignFrame.current = 0
      if (inflightKey.current === key) {
        inflightKey.current = null
      }
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

  const beginTarget = useCallback(
    (s: S, target: PreviousMessageTarget, animated: boolean, settled: boolean) => {
      const { latest, revealUndrawn } = argsRef.current
      if ('key' in target) {
        pendingAlign.current = null
        if (!alignRow(s, target.key, animated) && settled) {
          aligning.current = false
        }
        return
      }
      const index = latest.current.indexOf.get(target.pendingKey)
      if (index === undefined) {
        if (settled) {
          aligning.current = false
        }
        return
      }
      // Drop the old frame without recording the in-between offset as the reading place.
      haltFrame()
      inflightKey.current = target.pendingKey
      aligning.current = true
      pendingAlign.current = { key: target.pendingKey, animated, left: ALIGN_ATTEMPTS }
      if (index < latest.current.first) {
        revealUndrawn(index)
        return
      }
      if (alignRow(s, target.pendingKey, animated)) {
        pendingAlign.current = null
      }
    },
    [alignRow, haltFrame]
  )

  const revealPreviousMessage = useCallback(
    (stopKeys: readonly string[], animated: boolean) => {
      const s = argsRef.current.scroller()
      if (!s) {
        return
      }
      const fromKey = inflightKey.current
      if (fromKey) {
        const chained = previousMessageChained(stopsOf(s, stopKeys), fromKey)
        if (chained) {
          beginTarget(s, chained, animated, false)
        }
        return
      }
      settleScroll(s)
      const target = previousMessageTarget(stopsOf(s, stopKeys))
      if (!target) {
        aligning.current = false
        return
      }
      beginTarget(s, target, animated, true)
    },
    [beginTarget, settleScroll]
  )

  const cancelAlign = useCallback(() => {
    // A touch that does not scroll never reaches notePlace. Keep the offset where the jump stopped.
    if (aligning.current) {
      const s = argsRef.current.scroller()
      if (s) {
        argsRef.current.notePlace(s)
      }
    }
    haltFrame()
    aligning.current = false
    inflightKey.current = null
    pendingAlign.current = null
  }, [haltFrame])

  const finishPendingAlign = useCallback(
    (s: S) => {
      const pending = pendingAlign.current
      // A frame still running belongs to the current jump. Wait until the row can be aligned.
      if (!pending || alignFrame.current !== 0) {
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

  return { aligning, cancelAlign, hasPreviousMessage, revealPreviousMessage, finishPendingAlign }
}
